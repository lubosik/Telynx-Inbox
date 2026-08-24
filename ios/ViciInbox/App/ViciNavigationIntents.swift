import AppIntents

/// Siri and Shortcuts are adapters to the same deterministic coordinator used
/// by the in-app Assistant. They supply no record parameters, infer no entity,
/// and cannot confirm discarding an unsaved draft.
private enum ViciNavigationIntentAdapter {
    @MainActor
    static func run(reviewedPhrase: String,
                    successDialog: IntentDialog) async -> IntentDialog {
        let outcome = await AssistantNavigationCoordinator.shared.requestNavigation(
            for: reviewedPhrase,
            source: .appIntent
        )
        switch outcome {
        case .opened:
            return successDialog
        case .confirmationRequired, .discardRequested:
            return IntentDialog("Open Vici Inbox to review unsaved changes before continuing.")
        case .permissionDenied:
            return IntentDialog("This account does not have access to that screen.")
        case .clarification:
            return IntentDialog("Open Vici Inbox and choose the relevant screen first.")
        case .unavailable:
            return IntentDialog("That screen is not available in Vici Inbox right now.")
        case .cancelled:
            return IntentDialog("The request was cancelled safely.")
        case .notNavigation:
            return IntentDialog("That shortcut is not available.")
        }
    }
}

struct OpenRecentlyCreatedSegmentIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Recently Created Segment"
    static var description = IntentDescription(
        "Opens a segment created successfully in the current signed-in Vici Inbox session."
    )
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    // Xcode 26-compatible foreground behavior. Newer execution-mode APIs are
    // intentionally absent while the release lane remains on Xcode 26.
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let dialog = await ViciNavigationIntentAdapter.run(
            reviewedPhrase: "Take me to the segment you just created.",
            successDialog: IntentDialog("Opened the segment created in this session.")
        )
        return .result(dialog: dialog)
    }
}

struct OpenCurrentSegmentPeopleIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Current Segment People"
    static var description = IntentDescription(
        "Opens people and membership reasons for the segment currently visible in Vici Inbox."
    )
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let dialog = await ViciNavigationIntentAdapter.run(
            reviewedPhrase: "Open the people and show me why they are in it.",
            successDialog: IntentDialog("Opened the people and reasons for the current segment.")
        )
        return .result(dialog: dialog)
    }
}

struct OpenOffersIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Offers and Proposals"
    static var description = IntentDescription(
        "Opens the read-only Offers and Proposals screen when this account has access."
    )
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let dialog = await ViciNavigationIntentAdapter.run(
            reviewedPhrase: "Go to the offers.",
            successDialog: IntentDialog("Opened offers and proposals.")
        )
        return .result(dialog: dialog)
    }
}

struct ViciNavigationShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenRecentlyCreatedSegmentIntent(),
            phrases: [
                "Open my recent segment in \(.applicationName)",
                "Open the segment I created in \(.applicationName)"
            ],
            shortTitle: "Recent Segment",
            systemImageName: "person.3.sequence"
        )
        AppShortcut(
            intent: OpenCurrentSegmentPeopleIntent(),
            phrases: [
                "Show current segment people in \(.applicationName)",
                "Show why people are in this segment in \(.applicationName)"
            ],
            shortTitle: "Segment People",
            systemImageName: "person.3.fill"
        )
        AppShortcut(
            intent: OpenOffersIntent(),
            phrases: [
                "Open offers in \(.applicationName)",
                "Show offers and proposals in \(.applicationName)"
            ],
            shortTitle: "Offers",
            systemImageName: "tag.fill"
        )
    }

    static var shortcutTileColor: ShortcutTileColor = .teal
}
