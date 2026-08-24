import Foundation

@main
struct AssistantNavigationSmoke {
    @MainActor
    static func main() async {
        parserAcceptsOnlyCompleteKnownPhrases()
        sessionContextIsExactAndEphemeral()
        await coordinatorFailsClosedAndGuardsDrafts()
        print("Assistant navigation smoke: OK")
    }

    private static func parserAcceptsOnlyCompleteKnownPhrases() {
        precondition(
            AssistantNavigationParser.parse("Take me to the segment you just created.") ==
                .command(.lastCreatedSegment)
        )
        precondition(
            AssistantNavigationParser.parse("  OPEN   THE PEOPLE AND SHOW ME WHY THEY ARE IN IT!  ") ==
                .command(.currentSegmentPeople)
        )
        precondition(
            AssistantNavigationParser.parse("Go to the offers.") == .command(.offers)
        )
        precondition(
            AssistantNavigationParser.parse("open contacts") == .command(.fixed(.contacts))
        )

        let unsafeOrAmbiguous = [
            "do not go to the offers",
            "don't go to the offers",
            "\"go to the offers\"",
            "customer said go to the offers",
            "go to the offers and send to everyone",
            "go to offers now please then delete",
            "open segment seg-123",
            "open Recent buyers",
            "show segments",
            "show me offers",
            "offers"
        ]
        for phrase in unsafeOrAmbiguous {
            precondition(AssistantNavigationParser.parse(phrase) == .notNavigation,
                         "Must not route: \(phrase)")
        }
    }

    @MainActor
    private static func sessionContextIsExactAndEphemeral() {
        let context = AssistantNavigationContextStore(lifetime: 60)
        let start = Date(timeIntervalSince1970: 1_000)

        context.recordSuccessfullyCreatedSegment(
            id: "ignored", name: "No session", creationCapture: nil, now: start
        )
        context.beginAuthenticatedSession(userID: "owner-1")
        precondition(context.createdSegment(for: "owner-1", now: start) == nil)

        let ownerOneCapture = context.captureSegmentCreationSession()
        context.recordSuccessfullyCreatedSegment(
            id: "segment-1", name: "Recent buyers",
            creationCapture: ownerOneCapture, now: start
        )
        precondition(context.createdSegment(for: "owner-1", now: start)?.id == "segment-1")
        precondition(context.createdSegment(for: "owner-2", now: start) == nil)
        precondition(context.createdSegment(for: "owner-1", now: start.addingTimeInterval(61)) == nil)

        context.beginAuthenticatedSession(userID: "owner-2")
        precondition(context.createdSegment(for: "owner-2", now: start) == nil,
                     "Identity changes must not inherit segment context")
        context.recordSuccessfullyCreatedSegment(
            id: "late-owner-one", name: "Wrong session",
            creationCapture: ownerOneCapture, now: start
        )
        precondition(context.createdSegment(for: "owner-2", now: start) == nil,
                     "A late response must not be attributed to a new identity")
        let ownerTwoCapture = context.captureSegmentCreationSession()
        context.recordSuccessfullyCreatedSegment(
            id: "segment-2", name: "Right session",
            creationCapture: ownerTwoCapture, now: start
        )
        precondition(context.createdSegment(for: "owner-2", now: start)?.id == "segment-2")
    }

    @MainActor
    private static func coordinatorFailsClosedAndGuardsDrafts() async {
        let router = AppRouter.shared
        router.resetForSignOut()
        let context = AssistantNavigationContextStore(lifetime: 600)
        let drafts = AssistantUnsavedDraftRegistry()
        var clock = Date()
        var verifierCalls: [String] = []
        var authorizationResult = AssistantNavigationAuthorizationResult.authorized(
            AssistantNavigationAuthorization(
                userID: "owner-1",
                identityFingerprint: "owner-1|full",
                access: .unrestricted
            )
        )
        var preflightAllows = true
        let operations = AssistantNavigationOperations(
            revalidateAuthorization: { authorizationResult },
            verifySegment: { id in
                verifierCalls.append(id)
                return id == "segment-exact"
                    ? AssistantVerifiedSegment(id: id, name: "Exact segment")
                    : nil
            },
            preflightRoute: { _ in preflightAllows },
            segmentPeopleRoute: { _ in nil },
            offersRoute: { nil }
        )
        let coordinator = AssistantNavigationCoordinator(
            router: router,
            context: context,
            drafts: drafts,
            nowProvider: { clock },
            operations: operations
        )
        coordinator.updateRuntimeState(.active, callIsActive: false)
        coordinator.updateAuthenticatedSession(
            userID: "owner-1",
            identityFingerprint: "owner-1|full",
            access: .unrestricted
        )

        let noCreatedContext = await coordinator.requestNavigation(
            for: "Take me to the segment you just created."
        )
        guard case .clarification = noCreatedContext else {
            preconditionFailure("A list item must not stand in for current-session creation")
        }
        precondition(verifierCalls.isEmpty)

        context.recordSuccessfullyCreatedSegment(
            id: "segment-exact",
            name: "Draft name",
            creationCapture: context.captureSegmentCreationSession()
        )
        let exactTask = Task { @MainActor in
            await coordinator.requestNavigation(for: "Take me to the segment you just created.")
        }
        await waitUntil { router.growthPath == [.segment(id: "segment-exact", name: "Exact segment")] }
        coordinator.destinationDidBecomeVisible(.segment(id: "segment-exact", name: "Exact segment"))
        let exact = await exactTask.value
        precondition(exact == .opened(
            route: .segment(id: "segment-exact", name: "Exact segment"),
            confirmation: "Opened the segment created in this session."
        ))
        precondition(verifierCalls == ["segment-exact"])
        precondition(router.growthPath == [.segment(id: "segment-exact", name: "Exact segment")])

        coordinator.updateRuntimeState(.inactive, callIsActive: false)
        let siriRepeat = await coordinator.requestNavigation(
            for: "Take me to the segment you just created.",
            source: .appIntent
        )
        precondition(siriRepeat == .opened(
            route: .segment(id: "segment-exact", name: "Exact segment"),
            confirmation: "Opened the segment created in this session."
        ))
        precondition(context.createdSegment(for: "owner-1")?.id == "segment-exact",
                     "Transient Siri inactivity must preserve opaque context")
        coordinator.updateRuntimeState(.active, callIsActive: false)

        let people = await coordinator.requestNavigation(
            for: "Open the people and show me why they are in it."
        )
        guard case .unavailable = people else {
            preconditionFailure("No people route means no nearby route")
        }
        precondition(router.growthPath == [.segment(id: "segment-exact", name: "Exact segment")])

        let offers = await coordinator.requestNavigation(for: "Go to the offers.")
        guard case .unavailable = offers else {
            preconditionFailure("Offers must fail closed until its real route is installed")
        }

        let token = drafts.register(source: .message)
        drafts.setDirty(true, for: token)
        router.selectedTab = .inbox
        let guarded = await coordinator.requestNavigation(for: "Open contacts")
        guard case .confirmationRequired(let confirmation) = guarded else {
            preconditionFailure("Dirty drafts require visual confirmation")
        }
        precondition(router.selectedTab == .inbox)

        let discardOutcome = await coordinator.confirmDiscardByVisualAction(id: confirmation.id)
        guard case .discardRequested(let discard) = discardOutcome else {
            preconditionFailure("Visible confirmation must request owner-controlled discard")
        }
        precondition(router.selectedTab == .inbox, "Navigation must wait for owner acknowledgement")
        drafts.acknowledgeDiscard(for: token, requestID: discard.id)
        let openedTask = Task { @MainActor in
            await coordinator.completeConfirmedDiscardByVisualAction(
                confirmationID: confirmation.id,
                discardRequestID: discard.id
            )
        }
        await waitUntil { router.selectedTab == .contacts }
        coordinator.destinationDidBecomeVisible(.contacts)
        let opened = await openedTask.value
        precondition(opened == .opened(route: .contacts, confirmation: "Opened Contacts."))
        precondition(router.selectedTab == .contacts)
        precondition(!drafts.snapshot().hasUnsavedChanges)

        // Repeating an already visible exact root is idempotent and does not
        // wait for an appearance callback that SwiftUI may not emit again.
        let repeatedContacts = await coordinator.requestNavigation(for: "Open contacts")
        precondition(repeatedContacts == .opened(route: .contacts,
                                                 confirmation: "Opened Contacts."))

        drafts.setDirty(true, for: token)
        let expiring = await coordinator.requestNavigation(for: "Open calls")
        guard case .confirmationRequired(let expiringConfirmation) = expiring else {
            preconditionFailure("Expected expiring confirmation")
        }
        clock = Date().addingTimeInterval(61)
        let expiredOutcome = await coordinator.confirmDiscardByVisualAction(
            id: expiringConfirmation.id
        )
        precondition(expiredOutcome == .cancelled)
        precondition(drafts.snapshot().hasUnsavedChanges)
        drafts.setDirty(false, for: token)
        clock = Date()

        // A route that becomes unavailable while the visual prompt is shown
        // must fail before owner state is cleared.
        drafts.setDirty(true, for: token)
        let preflightGuard = await coordinator.requestNavigation(for: "Open calls")
        guard case .confirmationRequired(let preflightConfirmation) = preflightGuard else {
            preconditionFailure("Expected draft guard before preflight failure")
        }
        preflightAllows = false
        guard case .unavailable = await coordinator.confirmDiscardByVisualAction(
            id: preflightConfirmation.id
        ) else {
            preconditionFailure("Unavailable target must preserve the draft")
        }
        precondition(drafts.snapshot().hasUnsavedChanges)
        precondition(router.selectedTab == .contacts)
        preflightAllows = true
        drafts.setDirty(false, for: token)

        // Calls cancel a route that has mutated underneath the still-visible
        // Assistant sheet and atomically restore the prior verified route.
        let interrupted = Task { @MainActor in
            await coordinator.requestNavigation(for: "Open calls")
        }
        await waitUntil { router.selectedTab == .calls }
        coordinator.updateRuntimeState(.active, callIsActive: true)
        coordinator.reset(reason: .callStarted)
        let interruptedOutcome = await interrupted.value
        precondition(interruptedOutcome == .cancelled)
        precondition(router.selectedTab == .contacts)
        coordinator.updateRuntimeState(.active, callIsActive: false)

        // A newer request cannot inherit the first request's half-open route or
        // be completed by its stale timeout/callback.
        let first = Task { @MainActor in
            await coordinator.requestNavigation(for: "Open calls")
        }
        await waitUntil { router.selectedTab == .calls }
        let replacementTask = Task { @MainActor in
            await coordinator.requestNavigation(for: "Open analytics")
        }
        let firstOutcome = await first.value
        precondition(firstOutcome == .cancelled)
        await waitUntil { router.selectedTab == .analytics }
        coordinator.destinationDidBecomeVisible(.analytics)
        let replacementOutcome = await replacementTask.value
        precondition(replacementOutcome == .opened(
            route: .analytics, confirmation: "Opened Analytics."
        ))

        // The registry keeps active owner tokens after a discard. The same
        // editor becoming dirty again must still guard the next movement.
        drafts.setDirty(true, for: token)
        let guardedAgain = await coordinator.requestNavigation(for: "Open calls")
        guard case .confirmationRequired(let secondConfirmation) = guardedAgain else {
            preconditionFailure("An active owner must remain registered after discard")
        }
        guard case .discardRequested(let cancelledDiscard) =
                await coordinator.confirmDiscardByVisualAction(id: secondConfirmation.id) else {
            preconditionFailure("Expected a discard request before cancellation")
        }
        coordinator.cancelPendingConfirmation()
        precondition(drafts.discardRequest == nil)
        drafts.acknowledgeDiscard(for: token, requestID: cancelledDiscard.id)
        precondition(drafts.snapshot().hasUnsavedChanges,
                     "An owner must ignore a cancelled discard request")

        // A newer navigation replaces an old discard request, and a late old
        // confirmation cannot erase the newer confirmation.
        let oldGuard = await coordinator.requestNavigation(for: "Open calls")
        guard case .confirmationRequired(let oldConfirmation) = oldGuard,
              case .discardRequested(let oldDiscard) =
                await coordinator.confirmDiscardByVisualAction(id: oldConfirmation.id) else {
            preconditionFailure("Expected old discard flow")
        }
        let replacement = await coordinator.requestNavigation(for: "Open analytics")
        guard case .confirmationRequired(let replacementConfirmation) = replacement else {
            preconditionFailure("Expected replacement guard")
        }
        precondition(drafts.discardRequest == nil)
        let lateOldConfirmation = await coordinator.confirmDiscardByVisualAction(
            id: oldConfirmation.id
        )
        precondition(lateOldConfirmation == .cancelled)
        precondition(coordinator.pendingConfirmation == replacementConfirmation)
        drafts.acknowledgeDiscard(for: token, requestID: oldDiscard.id)
        precondition(drafts.snapshot().hasUnsavedChanges)
        drafts.setDirty(false, for: token)
        coordinator.cancelPendingConfirmation()

        let second = drafts.register(source: .segment)
        drafts.setDirty(true, for: second)
        let stale = await coordinator.requestNavigation(for: "Open calls")
        guard case .confirmationRequired(let staleConfirmation) = stale else {
            preconditionFailure("Expected another confirmation")
        }
        drafts.setDirty(false, for: second)
        guard case .clarification = await coordinator.confirmDiscardByVisualAction(id: staleConfirmation.id) else {
            preconditionFailure("A changed draft snapshot must invalidate confirmation")
        }
        precondition(router.selectedTab == .analytics)

        let denied = AppNavigationAccess(
            analytics: true,
            campaigns: false,
            activity: true,
            team: true,
            referrals: true,
            assistant: true
        )
        authorizationResult = .authorized(AssistantNavigationAuthorization(
            userID: "owner-1",
            identityFingerprint: "owner-1|full",
            access: denied
        ))
        coordinator.updateAuthenticatedSession(
            userID: "owner-1",
            identityFingerprint: "owner-1|full",
            access: denied
        )
        let audiences = await coordinator.requestNavigation(for: "Open audiences")
        guard case .permissionDenied = audiences else {
            preconditionFailure("Growth roots must respect campaign access")
        }
        precondition(router.selectedTab == .analytics)

        coordinator.reset(reason: .callStarted)
        precondition(context.createdSegment(for: "owner-1") == nil)
    }

    @MainActor
    private static func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            await Task.yield()
        }
        preconditionFailure("Timed out waiting for deterministic navigation state")
    }
}
