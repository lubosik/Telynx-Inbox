import Foundation
import Combine

/// In-memory context for one authenticated session. It records only a segment
/// that this app instance successfully created after the session was bound.
/// List loads, search results and previously persisted segments never populate
/// this value.
@MainActor
final class AssistantNavigationContextStore {
    static let shared = AssistantNavigationContextStore()

    private(set) var activeUserID: String?
    private(set) var sessionID: UUID?
    private var lastCreatedSegment: AssistantCreatedSegmentContext?
    private let lifetime: TimeInterval

    init(lifetime: TimeInterval = 30 * 60) {
        self.lifetime = lifetime
    }

    func beginAuthenticatedSession(userID rawUserID: String) {
        guard let userID = Self.clean(rawUserID) else {
            endAuthenticatedSession()
            return
        }
        guard activeUserID != userID || sessionID == nil else { return }
        activeUserID = userID
        sessionID = UUID()
        lastCreatedSegment = nil
    }

    func endAuthenticatedSession() {
        activeUserID = nil
        sessionID = nil
        lastCreatedSegment = nil
    }

    func clearEphemeralContext() {
        lastCreatedSegment = nil
        // Rotating this opaque epoch rejects a late create response that began
        // before a background, call, permission or capability boundary.
        if activeUserID != nil { sessionID = UUID() }
    }

    func captureSegmentCreationSession() -> AssistantSegmentCreationCapture? {
        sessionID.map { AssistantSegmentCreationCapture(sessionID: $0) }
    }

    /// Must be called only after the create endpoint returned success. The
    /// method fails closed before Root has bound an authenticated session.
    func recordSuccessfullyCreatedSegment(id rawID: String,
                                          name rawName: String?,
                                          creationCapture: AssistantSegmentCreationCapture?,
                                          now: Date = Date()) {
        guard let userID = activeUserID,
              let sessionID,
              creationCapture?.sessionID == sessionID,
              let id = Self.clean(rawID) else { return }
        lastCreatedSegment = AssistantCreatedSegmentContext(
            id: id,
            name: Self.clean(rawName),
            createdAt: now,
            sessionID: sessionID,
            userID: userID
        )
    }

    func createdSegment(for rawUserID: String, now: Date = Date()) -> AssistantCreatedSegmentContext? {
        guard let userID = Self.clean(rawUserID),
              userID == activeUserID,
              let sessionID,
              let segment = lastCreatedSegment,
              segment.userID == userID,
              segment.sessionID == sessionID,
              now >= segment.createdAt,
              now.timeIntervalSince(segment.createdAt) <= lifetime else {
            return nil
        }
        return segment
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : clean
    }
}

/// Global dirty-state bookkeeping for guarded programmatic navigation.
/// Entries contain only an opaque token, a generic source and one boolean. No
/// draft text, attachment, customer identity or save/discard closure is kept.
@MainActor
final class AssistantUnsavedDraftRegistry: ObservableObject {
    static let shared = AssistantUnsavedDraftRegistry()

    private struct Entry {
        let source: AssistantDraftSource
        var isDirty: Bool
        var acknowledgedDiscardID: UUID?
    }

    @Published private(set) var revision: UInt64 = 0
    @Published private(set) var discardRequest: AssistantDraftDiscardRequest?
    private var entries: [AssistantDraftToken: Entry] = [:]

    @discardableResult
    func register(source: AssistantDraftSource) -> AssistantDraftToken {
        let token = AssistantDraftToken()
        entries[token] = Entry(source: source, isDirty: false, acknowledgedDiscardID: nil)
        return token
    }

    func setDirty(_ isDirty: Bool, for token: AssistantDraftToken) {
        guard var entry = entries[token], entry.isDirty != isDirty else { return }
        entry.isDirty = isDirty
        if isDirty { entry.acknowledgedDiscardID = nil }
        entries[token] = entry
        revision &+= 1
    }

    func unregister(_ token: AssistantDraftToken) {
        guard let removed = entries.removeValue(forKey: token) else { return }
        if removed.isDirty { revision &+= 1 }
    }

    func beginConfirmedDiscard(snapshot: AssistantDraftSnapshot,
                               confirmationID: UUID) -> AssistantDraftDiscardRequest? {
        let current = self.snapshot()
        guard current == snapshot, current.hasUnsavedChanges else { return nil }
        let request = AssistantDraftDiscardRequest(
            id: UUID(),
            confirmationID: confirmationID,
            tokenIDs: snapshot.dirtyTokenIDs,
            sources: snapshot.dirtySources
        )
        for token in entries.keys where request.tokenIDs.contains(token.id) {
            entries[token]?.acknowledgedDiscardID = nil
        }
        discardRequest = request
        return request
    }

    /// The owning view calls this only after it has cleared its own local state
    /// and dismissed any local sheet. No content or discard callback is stored
    /// in this registry.
    func acknowledgeDiscard(for token: AssistantDraftToken, requestID: UUID) {
        guard let request = discardRequest,
              request.id == requestID,
              request.tokenIDs.contains(token.id),
              var entry = entries[token] else { return }
        let changedDirtyState = entry.isDirty
        entry.isDirty = false
        entry.acknowledgedDiscardID = request.id
        entries[token] = entry
        if changedDirtyState { revision &+= 1 }
    }

    func isAcknowledged(_ request: AssistantDraftDiscardRequest) -> Bool {
        guard discardRequest?.id == request.id else { return false }
        let unresolved = request.tokenIDs.filter { tokenID in
            guard let entry = entries.first(where: { $0.key.id == tokenID })?.value else {
                return false
            }
            return entry.isDirty || entry.acknowledgedDiscardID != request.id
        }
        return unresolved.isEmpty && !snapshot().hasUnsavedChanges
    }

    func finishDiscard(_ request: AssistantDraftDiscardRequest) {
        guard discardRequest?.id == request.id else { return }
        discardRequest = nil
    }

    func cancelDiscard() {
        discardRequest = nil
    }

    func snapshot() -> AssistantDraftSnapshot {
        let dirty = entries.filter { $0.value.isDirty }
        let presentSources = Set(dirty.map { $0.value.source })
        return AssistantDraftSnapshot(
            revision: revision,
            dirtyTokenIDs: Set(dirty.map { $0.key.id }),
            dirtySources: AssistantDraftSource.allCases.filter { presentSources.contains($0) }
        )
    }

    func resetForSignOut() {
        entries.removeAll()
        discardRequest = nil
        revision &+= 1
    }
}

/// Exact record verification and routes are injected by the app layer. The
/// default is deliberately unsupported, so a missing Offers screen or segment
/// people route cannot silently become Campaigns or a nearby list.
struct AssistantNavigationOperations {
    var revalidateAuthorization: @MainActor () async -> AssistantNavigationAuthorizationResult
    var verifySegment: @MainActor (String) async -> AssistantVerifiedSegment?
    var preflightRoute: @MainActor (AppRoute) async -> Bool
    var segmentPeopleRoute: @MainActor (AssistantVerifiedSegment) -> AppRoute?
    var offersRoute: @MainActor () -> AppRoute?

    static let unsupported = AssistantNavigationOperations(
        revalidateAuthorization: { .unverifiable },
        verifySegment: { _ in nil },
        preflightRoute: { _ in false },
        segmentPeopleRoute: { _ in nil },
        offersRoute: { nil }
    )
}

enum AssistantNavigationResetReason: Equatable {
    case background
    case callStarted
    case signedOut
    case identityChanged
    case permissionChanged
    case capabilityDisabled
}

@MainActor
final class AssistantNavigationCoordinator: ObservableObject {
    static let shared = AssistantNavigationCoordinator()

    @Published private(set) var pendingConfirmation: AssistantNavigationConfirmation?
    @Published private(set) var announcement: AssistantNavigationAnnouncement?

    var hasNavigationInFlight: Bool {
        pendingVisibility != nil || pendingConfirmation != nil
    }

    private struct PendingNavigation {
        let confirmation: AssistantNavigationConfirmation
        let route: AppRoute
        let successMessage: String
        let userID: String
        let sessionID: UUID
        let snapshot: AssistantDraftSnapshot
        let expiresAt: Date
        let generation: UInt64
        let source: AssistantNavigationSource
        let speechCompletionUptime: TimeInterval?
    }

    private struct PendingVisibility {
        let route: AppRoute
        let successMessage: String
        let userID: String
        let identityFingerprint: String
        let generation: UInt64
        let source: AssistantNavigationSource
        let speechCompletionUptime: TimeInterval?
        let previousRoute: AppRoute
        let previousAccountRoute: AppRoute?
        let wasAccountPresented: Bool
        let access: AppNavigationAccess
    }

    private let router: AppRouter
    private let context: AssistantNavigationContextStore
    private let drafts: AssistantUnsavedDraftRegistry
    private let nowProvider: () -> Date
    private var operations: AssistantNavigationOperations
    private var activeUserID: String?
    private var activeIdentityFingerprint: String?
    private var activeAccess: AppNavigationAccess?
    private var pending: PendingNavigation?
    private var pendingVisibility: PendingVisibility?
    private var lastVisibleRoute: AppRoute?
    private var visibilityContinuation: CheckedContinuation<AssistantNavigationOutcome, Never>?
    private var visibilityTimeoutTask: Task<Void, Never>?
    private var generation: UInt64 = 0
    private var resolutionTask: Task<AssistantNavigationOutcome, Never>?
    private var isConfigured = false
    private var runtimeState: AssistantNavigationRuntimeState = .background
    private var callIsActive = true

    init(router: AppRouter = .shared,
         context: AssistantNavigationContextStore = .shared,
         drafts: AssistantUnsavedDraftRegistry = .shared,
         nowProvider: @escaping () -> Date = Date.init,
         operations: AssistantNavigationOperations = .unsupported) {
        self.router = router
        self.context = context
        self.drafts = drafts
        self.nowProvider = nowProvider
        self.operations = operations
    }

    /// Root must call this whenever the authenticated identity or effective
    /// navigation permissions change. A change invalidates every in-flight or
    /// pending result before it can move the app.
    func updateAuthenticatedSession(userID rawUserID: String?,
                                    identityFingerprint rawFingerprint: String? = nil,
                                    access: AppNavigationAccess?) {
        let userID = rawUserID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fingerprint = rawFingerprint?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? userID
        guard let userID, !userID.isEmpty, let access else {
            reset(reason: .signedOut)
            activeUserID = nil
            activeIdentityFingerprint = nil
            activeAccess = nil
            context.endAuthenticatedSession()
            drafts.resetForSignOut()
            return
        }

        if activeUserID != userID || activeIdentityFingerprint != fingerprint {
            reset(reason: .identityChanged)
            activeUserID = userID
            activeIdentityFingerprint = fingerprint
            activeAccess = access
            context.beginAuthenticatedSession(userID: userID)
            drafts.resetForSignOut()
            return
        }

        if activeAccess != access {
            reset(reason: .permissionChanged)
            activeAccess = access
        }
    }

    /// The app target installs its real read-only verifier and newly introduced
    /// typed routes here. Configuration is a capability boundary, so stale
    /// work from an earlier configuration is cancelled.
    func configure(operations: AssistantNavigationOperations) {
        reset(reason: .capabilityDisabled)
        self.operations = operations
        isConfigured = true
    }

    /// SwiftUI may rebuild the root view without starting a new process. The
    /// operation closures are process-stable, so installing them again would
    /// needlessly erase valid current-session context.
    func configureIfNeeded(operations: AssistantNavigationOperations) {
        guard !isConfigured else { return }
        configure(operations: operations)
    }

    /// Root pushes lifecycle/call state into this reference-owned monitor. No
    /// process-stable closure captures a stale SwiftUI Environment value.
    func updateRuntimeState(_ state: AssistantNavigationRuntimeState,
                            callIsActive: Bool) {
        runtimeState = state
        self.callIsActive = callIsActive
    }

    private func runtimePermits(_ source: AssistantNavigationSource) -> Bool {
        !callIsActive && runtimeState.permits(source)
    }

    func reset(reason: AssistantNavigationResetReason) {
        generation &+= 1
        resolutionTask?.cancel()
        resolutionTask = nil
        cancelPendingVisibility(returning: .cancelled)
        pending = nil
        pendingConfirmation = nil
        announcement = nil
        drafts.cancelDiscard()

        switch reason {
        case .background, .callStarted, .identityChanged, .permissionChanged,
             .capabilityDisabled:
            context.clearEphemeralContext()
            lastVisibleRoute = nil
        case .signedOut:
            context.endAuthenticatedSession()
            lastVisibleRoute = nil
        }
    }

    func requestNavigation(for completeText: String,
                           source: AssistantNavigationSource = .assistantTyped,
                           speechCompletionUptime: TimeInterval? = nil,
                           now: Date = Date()) async -> AssistantNavigationOutcome {
        let parsed = AssistantNavigationParser.parse(completeText)
        guard case .command(let command) = parsed else { return .notNavigation }
        if source == .appIntent { await waitForAppIntentReadiness() }
        guard !Task.isCancelled else { return .cancelled }
        guard activeUserID != nil, activeIdentityFingerprint != nil,
              activeAccess != nil, context.sessionID != nil else {
            return .unavailable("Sign in again before using Assistant navigation.")
        }

        generation &+= 1
        let requestGeneration = generation
        resolutionTask?.cancel()
        cancelPendingVisibility(returning: .cancelled)
        drafts.cancelDiscard()
        pending = nil
        pendingConfirmation = nil
        announcement = nil

        let task = Task { @MainActor [weak self] () -> AssistantNavigationOutcome in
            guard let self else { return .cancelled }
            return await self.resolve(command,
                                      generation: requestGeneration,
                                      source: source,
                                      speechCompletionUptime: speechCompletionUptime,
                                      now: now)
        }
        resolutionTask = task
        let outcome = await task.value
        if generation == requestGeneration { resolutionTask = nil }
        return outcome
    }

    private func waitForAppIntentReadiness() async {
        // `openAppWhenRun` can invoke perform while SessionModel is still
        // restoring its authenticated cookie. This wait never manufactures a
        // session or bypasses the later fresh server checks; it merely lets
        // Root bind the real one on a cold foreground launch.
        for _ in 0..<100 {
            if isConfigured,
               activeUserID != nil,
               activeIdentityFingerprint != nil,
               activeAccess != nil,
               context.sessionID != nil,
               runtimePermits(.appIntent) { return }
            guard !Task.isCancelled else { return }
            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return
            }
        }
    }

    /// This is intentionally not callable with spoken or typed confirmation.
    /// Only a visible button holding the opaque confirmation id may discard.
    func confirmDiscardByVisualAction(id: UUID,
                                      now: Date? = nil) async -> AssistantNavigationOutcome {
        let entryNow = now ?? nowProvider()
        guard let pending else { return .cancelled }
        // A late button/result from an older sheet must not cancel a newer
        // confirmation that now owns the visible flow.
        guard pending.confirmation.id == id else { return .cancelled }
        guard
              entryNow <= pending.expiresAt,
              pending.userID == activeUserID,
              pending.sessionID == context.sessionID,
              runtimePermits(pending.source),
              let access = activeAccess else {
            clearPendingConfirmation()
            return .cancelled
        }

        let current = drafts.snapshot()
        guard current.revision == pending.snapshot.revision,
              current.dirtyTokenIDs == pending.snapshot.dirtyTokenIDs else {
            clearPendingConfirmation()
            return .clarification("Unsaved changes changed. Review them before navigating.")
        }
        guard pending.route.isWellFormed, access.permits(pending.route) else {
            clearPendingConfirmation()
            return .permissionDenied("Your access changed before the screen could open.")
        }

        // Preserve every owner draft unless the exact route and fresh account
        // authorization are reachable now. A second identical check still runs
        // after owners acknowledge, because the visual flow is an awaitable
        // trust boundary rather than a promise that state cannot change.
        async let authorizationRead = operations.revalidateAuthorization()
        async let targetRead = operations.preflightRoute(pending.route)
        let (authorizationResult, targetReady) = await (authorizationRead, targetRead)
        guard self.pending?.confirmation.id == id,
              nowProvider() <= pending.expiresAt,
              pending.userID == activeUserID,
              pending.sessionID == context.sessionID,
              runtimePermits(pending.source) else { return .cancelled }
        guard targetReady else {
            clearPendingConfirmation()
            let outcome = AssistantNavigationOutcome.unavailable(
                "The requested screen could not be verified. Your draft was kept."
            )
            publishTerminalOutcome(outcome, source: pending.source)
            return outcome
        }
        let freshAuthorization: AssistantNavigationAuthorization
        switch authorizationResult {
        case .authorized(let authorization):
            freshAuthorization = authorization
        case .capabilityDisabled, .identityOrPermissionChanged:
            context.clearEphemeralContext()
            clearPendingConfirmation()
            let outcome = AssistantNavigationOutcome.permissionDenied(
                "Your access changed. Your draft was kept."
            )
            publishTerminalOutcome(outcome, source: pending.source)
            return outcome
        case .unverifiable:
            clearPendingConfirmation()
            let outcome = AssistantNavigationOutcome.unavailable(
                "Your access could not be verified. Your draft was kept."
            )
            publishTerminalOutcome(outcome, source: pending.source)
            return outcome
        }
        guard freshAuthorization.userID == pending.userID,
              freshAuthorization.identityFingerprint == activeIdentityFingerprint,
              freshAuthorization.access == activeAccess,
              freshAuthorization.access.assistant,
              freshAuthorization.access.permits(pending.route) else {
            context.clearEphemeralContext()
            clearPendingConfirmation()
            let outcome = AssistantNavigationOutcome.permissionDenied(
                "Your access changed. Your draft was kept."
            )
            publishTerminalOutcome(outcome, source: pending.source)
            return outcome
        }

        let latest = drafts.snapshot()
        guard latest.revision == pending.snapshot.revision,
              latest.dirtyTokenIDs == pending.snapshot.dirtyTokenIDs else {
            clearPendingConfirmation()
            return .clarification("Unsaved changes changed. Review them before navigating.")
        }
        guard let discard = drafts.beginConfirmedDiscard(snapshot: latest,
                                                          confirmationID: id) else {
            clearPendingConfirmation()
            return .clarification("Unsaved changes changed. Review them before navigating.")
        }
        pendingConfirmation = nil
        return .discardRequested(discard)
    }

    /// Call after every draft owner named by `discardRequested` has cleared its
    /// own local draft, dismissed its local presentation and acknowledged its
    /// opaque token. Navigation never precedes those acknowledgements.
    func completeConfirmedDiscardByVisualAction(confirmationID: UUID,
                                                discardRequestID: UUID,
                                                now: Date? = nil) async -> AssistantNavigationOutcome {
        let entryNow = now ?? nowProvider()
        guard let pending else { return .cancelled }
        guard pending.confirmation.id == confirmationID else { return .cancelled }
        guard
              let request = drafts.discardRequest,
              request.id == discardRequestID,
              request.confirmationID == confirmationID,
              entryNow <= pending.expiresAt,
              pending.userID == activeUserID,
              pending.sessionID == context.sessionID else {
            clearPendingConfirmation()
            drafts.cancelDiscard()
            return .cancelled
        }
        guard drafts.isAcknowledged(request) else {
            return .clarification("Finish discarding unsaved changes before navigating.")
        }
        guard pending.route.isWellFormed else {
            clearPendingConfirmation()
            drafts.finishDiscard(request)
            return .unavailable("That exact screen is not available.")
        }

        let route = pending.route
        let successMessage = pending.successMessage
        let userID = pending.userID
        let requestGeneration = pending.generation
        let source = pending.source
        let speechCompletionUptime = pending.speechCompletionUptime
        // The visual prompt may remain on screen for up to a minute. Treat it
        // as a full trust boundary: identity, capability, permission, runtime,
        // and the exact target are all read again after every owner has cleared
        // its local draft.
        let outcome = await validateOpenAndAwaitVisibility(
            route: route,
            successMessage: successMessage,
            userID: userID,
            generation: requestGeneration,
            source: source,
            speechCompletionUptime: speechCompletionUptime,
            targetWasJustVerified: false,
            expiresAt: pending.expiresAt
        )
        drafts.finishDiscard(request)
        if case .opened = outcome { clearPendingConfirmation() }
        else {
            clearPendingConfirmation()
            publishTerminalOutcome(outcome, source: source)
        }
        return outcome
    }

    func cancelPendingConfirmation() {
        clearPendingConfirmation()
        drafts.cancelDiscard()
    }

    func publishVisualActionOutcome(_ outcome: AssistantNavigationOutcome) {
        switch outcome {
        case .discardRequested, .opened, .cancelled, .notNavigation:
            return
        default:
            guard let message = AssistantNavigationResponseCopy.text(for: outcome),
                  announcement?.message != message else { return }
            announcement = AssistantNavigationAnnouncement(
                id: UUID(), message: message, source: .assistantTyped
            )
        }
    }

    // MARK: - Resolution

    private func resolve(_ command: AssistantNavigationCommand,
                         generation requestGeneration: UInt64,
                         source: AssistantNavigationSource,
                         speechCompletionUptime: TimeInterval?,
                         now: Date) async -> AssistantNavigationOutcome {
        guard let userID = activeUserID, let access = activeAccess,
              runtimePermits(source) else { return .cancelled }

        let resolved: (route: AppRoute, message: String, targetWasJustVerified: Bool)?
        switch command {
        case .lastCreatedSegment:
            guard access.campaigns else {
                return .permissionDenied("You do not have access to audiences.")
            }
            guard let created = context.createdSegment(for: userID, now: now) else {
                return .clarification("Create a segment in this signed-in session, then try again.")
            }
            guard let verified = await operations.verifySegment(created.id),
                  stillCurrent(requestGeneration, userID: userID),
                  verified.id == created.id else {
                return Task.isCancelled ? .cancelled : .unavailable("The segment created in this session is no longer available.")
            }
            resolved = (.segment(id: verified.id, name: verified.name ?? created.name),
                        "Opened the segment created in this session.", true)

        case .currentSegmentPeople:
            guard access.campaigns else {
                return .permissionDenied("You do not have access to audiences.")
            }
            let currentSegment: (id: String, name: String?)?
            switch router.currentMainRoute {
            case .segment(let id, let name), .segmentPeople(let id, let name):
                currentSegment = (id, name)
            default:
                currentSegment = nil
            }
            guard let currentSegment else {
                return .clarification("Open a segment first, then ask to see its people and reasons.")
            }
            let segmentID = currentSegment.id
            let segmentName = currentSegment.name
            guard let verified = await operations.verifySegment(segmentID),
                  stillCurrent(requestGeneration, userID: userID),
                  verified.id == segmentID else {
                return Task.isCancelled ? .cancelled : .unavailable("That segment is no longer available.")
            }
            let currentID: String?
            switch router.currentMainRoute {
            case .segment(let id, _), .segmentPeople(let id, _): currentID = id
            default: currentID = nil
            }
            guard currentID == segmentID else {
                return .clarification("The current segment changed before navigation finished.")
            }
            let exactSegment = AssistantVerifiedSegment(id: verified.id,
                                                        name: verified.name ?? segmentName)
            guard let route = operations.segmentPeopleRoute(exactSegment) else {
                return .unavailable("The people and reasons screen is not available in this build.")
            }
            resolved = (route, "Opened the people and reasons for this segment.", true)

        case .offers:
            guard access.campaignsManage else {
                return .permissionDenied("You do not have access to offers and proposals.")
            }
            guard let route = operations.offersRoute() else {
                return .unavailable("Offers and proposals is not available in this build.")
            }
            resolved = (route, "Opened offers and proposals.", false)

        case .fixed(let destination):
            let fixed = fixedRoute(for: destination)
            resolved = (fixed.0, fixed.1, false)
        }

        guard stillCurrent(requestGeneration, userID: userID) else { return .cancelled }
        guard let resolved else { return .unavailable("That screen is not available.") }
        guard resolved.route.isWellFormed else {
            return .unavailable("That exact screen is not available.")
        }
        guard access.permits(resolved.route) else {
            return .permissionDenied("You do not have access to that screen.")
        }

        let snapshot = drafts.snapshot()
        if snapshot.hasUnsavedChanges {
            return prepareConfirmation(route: resolved.route,
                                       message: resolved.message,
                                       snapshot: snapshot,
                                       userID: userID,
                                       generation: requestGeneration,
                                       source: source,
                                       now: now)
        }

        return await validateOpenAndAwaitVisibility(
            route: resolved.route,
            successMessage: resolved.message,
            userID: userID,
            generation: requestGeneration,
            source: source,
            speechCompletionUptime: speechCompletionUptime,
            targetWasJustVerified: resolved.targetWasJustVerified,
            expiresAt: nil
        )
    }

    private func fixedRoute(for destination: AssistantFixedNavigationDestination) -> (AppRoute, String) {
        switch destination {
        case .inbox: return (.inbox, "Opened Inbox.")
        case .contacts: return (.contacts, "Opened Contacts.")
        case .automations: return (.growth(.automations), "Opened Automations.")
        case .campaigns: return (.growth(.campaigns), "Opened Campaigns.")
        case .audiences: return (.growth(.audiences), "Opened Audiences.")
        case .calls: return (.calls, "Opened Calls.")
        case .analytics: return (.analytics, "Opened Analytics.")
        case .referrals: return (.referrals, "Opened Referrals.")
        case .settings: return (.settings, "Opened Settings.")
        }
    }

    private func prepareConfirmation(route: AppRoute,
                                     message: String,
                                     snapshot: AssistantDraftSnapshot,
                                     userID: String,
                                     generation requestGeneration: UInt64,
                                     source: AssistantNavigationSource,
                                     now: Date) -> AssistantNavigationOutcome {
        guard let sessionID = context.sessionID else { return .cancelled }
        let labels = snapshot.dirtySources.map(\.label)
        let subject = labels.isEmpty ? "changes" : labels.joined(separator: ", ") + " changes"
        let confirmation = AssistantNavigationConfirmation(
            id: UUID(),
            message: "Unsaved \(subject) will be discarded. Continue?",
            dirtySources: snapshot.dirtySources
        )
        pending = PendingNavigation(
            confirmation: confirmation,
            route: route,
            successMessage: message,
            userID: userID,
            sessionID: sessionID,
            snapshot: snapshot,
            expiresAt: now.addingTimeInterval(60),
            generation: requestGeneration,
            source: source,
            // Human confirmation time is deliberately excluded from the
            // <1.5s voice-navigation system budget.
            speechCompletionUptime: nil
        )
        pendingConfirmation = confirmation
        return .confirmationRequired(confirmation)
    }

    /// Destination views call this from `onAppear` only after SwiftUI has
    /// materialised the exact typed route. Router mutation alone is not treated
    /// as success, because doing so can announce a screen that never rendered.
    func destinationDidBecomeVisible(_ route: AppRoute,
                                     nowUptime: TimeInterval = AssistantMonotonicClock.now) {
        lastVisibleRoute = route
        guard let visible = pendingVisibility,
              visible.route == route,
              visible.generation == generation,
              visible.userID == activeUserID,
              visible.identityFingerprint == activeIdentityFingerprint,
              visible.access == activeAccess,
              runtimePermits(visible.source),
              router.currentMainRoute == route || route.isAccountRoute else { return }

        visibilityTimeoutTask?.cancel()
        visibilityTimeoutTask = nil
        pendingVisibility = nil
        let completion = visibilityContinuation
        visibilityContinuation = nil

        // Main-tab content was prepared underneath the still-present Assistant
        // sheet. Dismiss only after the exact destination has acknowledged its
        // authoritative loaded state; a timeout therefore leaves the user and
        // their transcript on the screen where the command began.
        if visible.route.tab != nil { router.dismissAccount() }

        if visible.source == .assistantVoice,
           let start = visible.speechCompletionUptime {
            AssistantLatencyRecorder.shared.record(
                .voiceNavigation,
                startUptime: start,
                endUptime: nowUptime
            )
        }
        announcement = AssistantNavigationAnnouncement(
            id: UUID(),
            message: visible.successMessage,
            source: visible.source
        )
        completion?.resume(returning: .opened(
            route: visible.route,
            confirmation: visible.successMessage
        ))
    }

    private func validateOpenAndAwaitVisibility(
        route: AppRoute,
        successMessage: String,
        userID: String,
        generation requestGeneration: UInt64,
        source: AssistantNavigationSource,
        speechCompletionUptime: TimeInterval?,
        targetWasJustVerified: Bool,
        expiresAt: Date?
    ) async -> AssistantNavigationOutcome {
        guard route.isWellFormed, runtimePermits(source) else { return .cancelled }

        // Authorization and target readiness are independent reads. Run them
        // together, then perform the only router mutation immediately after
        // comparing the complete fresh result with the initiating session.
        async let authorizationRead = operations.revalidateAuthorization()
        async let targetRead: Bool = targetWasJustVerified
            ? true
            : operations.preflightRoute(route)
        let (authorizationResult, targetReady) = await (authorizationRead, targetRead)

        guard targetReady,
              stillCurrent(requestGeneration, userID: userID),
              routeContextIsStillExact(route) else {
            return Task.isCancelled ? .cancelled
                : .unavailable("The requested screen could not be verified. Nothing was opened.")
        }

        let finalAuthorization: AssistantNavigationAuthorization
        switch authorizationResult {
        case .authorized(let authorization):
            finalAuthorization = authorization
        case .capabilityDisabled, .identityOrPermissionChanged:
            guard stillCurrent(requestGeneration, userID: userID) else { return .cancelled }
            context.clearEphemeralContext()
            return .permissionDenied("Your access changed before the screen could open.")
        case .unverifiable:
            return Task.isCancelled ? .cancelled
                : .unavailable("Your access could not be verified. Nothing was opened.")
        }
        guard finalAuthorization.userID == userID,
              finalAuthorization.identityFingerprint == activeIdentityFingerprint,
              finalAuthorization.access == activeAccess,
              finalAuthorization.access.assistant,
              finalAuthorization.access.permits(route),
              runtimePermits(source),
              expiresAt.map({ nowProvider() <= $0 }) ?? true,
              stillCurrent(requestGeneration, userID: userID) else {
            if stillCurrent(requestGeneration, userID: userID) {
                context.clearEphemeralContext()
            }
            return Task.isCancelled ? .cancelled
                : .permissionDenied("Your access changed before the screen could open.")
        }

        let previousRoute = router.currentMainRoute
        let previousAccountRoute = router.accountPath.last
        let wasAccountPresented = router.isAccountPresented
        let wasAlreadyVisible = lastVisibleRoute == route
        return await withCheckedContinuation { continuation in
            pendingVisibility = PendingVisibility(
                route: route,
                successMessage: successMessage,
                userID: userID,
                identityFingerprint: finalAuthorization.identityFingerprint,
                generation: requestGeneration,
                source: source,
                speechCompletionUptime: speechCompletionUptime,
                previousRoute: previousRoute,
                previousAccountRoute: previousAccountRoute,
                wasAccountPresented: wasAccountPresented,
                access: finalAuthorization.access
            )
            visibilityContinuation = continuation
            guard open(route, access: finalAuthorization.access) else {
                pendingVisibility = nil
                visibilityContinuation = nil
                continuation.resume(returning: .unavailable("That screen could not be opened."))
                return
            }

            if wasAlreadyVisible {
                Task { @MainActor [weak self] in
                    await Task.yield()
                    self?.destinationDidBecomeVisible(route)
                }
            }

            visibilityTimeoutTask?.cancel()
            visibilityTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                guard !Task.isCancelled else { return }
                self?.failPendingVisibility()
            }
        }
    }

    private func failPendingVisibility() {
        guard let visible = pendingVisibility else { return }
        rollbackPendingVisibilityIfNeeded(visible)
        pendingVisibility = nil
        visibilityTimeoutTask?.cancel()
        visibilityTimeoutTask = nil
        let completion = visibilityContinuation
        visibilityContinuation = nil

        if visible.source != .appIntent {
            announcement = AssistantNavigationAnnouncement(
                id: UUID(),
                message: "That screen could not be opened.",
                source: visible.source
            )
        }
        completion?.resume(returning: .unavailable("That screen could not be opened."))
    }

    private func cancelPendingVisibility(returning outcome: AssistantNavigationOutcome) {
        visibilityTimeoutTask?.cancel()
        visibilityTimeoutTask = nil
        if let visible = pendingVisibility {
            rollbackPendingVisibilityIfNeeded(visible)
        }
        pendingVisibility = nil
        let continuation = visibilityContinuation
        visibilityContinuation = nil
        continuation?.resume(returning: outcome)
    }

    private func rollbackPendingVisibilityIfNeeded(_ visible: PendingVisibility) {
        if visible.route.isAccountRoute {
            guard router.accountPath.last == visible.route else { return }
            if visible.wasAccountPresented {
                if let previous = visible.previousAccountRoute,
                   previous.isWellFormed,
                   visible.access.permits(previous) {
                    _ = router.open(previous, access: visible.access)
                } else {
                    router.presentAccount()
                }
            } else {
                router.dismissAccount()
            }
            return
        }
        guard router.currentMainRoute == visible.route,
              visible.previousRoute.isWellFormed,
              visible.access.permits(visible.previousRoute) else { return }
        _ = router.open(visible.previousRoute, access: visible.access)
    }

    private func publishTerminalOutcome(_ outcome: AssistantNavigationOutcome,
                                        source: AssistantNavigationSource) {
        guard source != .appIntent,
              let message = AssistantNavigationResponseCopy.text(for: outcome) else { return }
        announcement = AssistantNavigationAnnouncement(
            id: UUID(),
            message: message,
            source: source
        )
    }

    private func stillCurrent(_ requestGeneration: UInt64, userID: String) -> Bool {
        !Task.isCancelled && generation == requestGeneration && activeUserID == userID
    }

    private func routeContextIsStillExact(_ route: AppRoute) -> Bool {
        guard case .segmentPeople(let expectedID, _) = route else { return true }
        switch router.currentMainRoute {
        case .segment(let currentID, _), .segmentPeople(let currentID, _):
            return currentID == expectedID
        default:
            return false
        }
    }

    private func open(_ route: AppRoute, access: AppNavigationAccess) -> Bool {
        router.open(route, access: access)
    }

    private func clearPendingConfirmation() {
        pending = nil
        pendingConfirmation = nil
    }
}
