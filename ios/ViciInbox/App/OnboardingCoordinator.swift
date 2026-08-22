import Foundation
import Combine

@MainActor
final class OnboardingCoordinator: ObservableObject {
    @Published private(set) var steps: [OnboardingStep] = []
    @Published private(set) var index = 0
    @Published private(set) var isPresented = false
    @Published private(set) var isManualReplay = false

    private var userID: String?
    private var version: Int?
    private let defaults: UserDefaults

    var currentStep: OnboardingStep? {
        guard steps.indices.contains(index) else { return nil }
        return steps[index]
    }

    var progressText: String {
        guard !steps.isEmpty else { return "" }
        return "\(index + 1) of \(steps.count)"
    }

    var canGoBack: Bool { index > 0 }
    var isLastStep: Bool { index == steps.count - 1 }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Starts only after the server positively identifies this account as new.
    /// Missing state, a legacy account and a temporary fetch failure all leave
    /// the current interface untouched.
    func considerAutomaticTour(for user: AuthUser?) {
        guard !isPresented,
              let user,
              !user.isSharedTeamLogin else { return }

        if let state = user.onboarding,
           let version = state.version,
           let pending = pendingDecision(userID: user.id, version: version) {
            retryPendingDecision(pending, userID: user.id, version: version)
        }

        guard let version = user.onboarding?.automaticTourVersion,
              !isLocallySuppressed(userID: user.id, version: version) else { return }

        let plan = OnboardingPlan.steps(for: user)
        guard !plan.isEmpty else { return }
        begin(plan: plan, userID: user.id, version: version, manual: false)
    }

    /// Manual replay never modifies first-run completion state.
    func startManualReplay(for user: AuthUser?) {
        guard let user, !user.isSharedTeamLogin else { return }
        let plan = OnboardingPlan.steps(for: user)
        guard !plan.isEmpty else { return }
        begin(plan: plan, userID: user.id, version: user.onboarding?.version, manual: true)
    }

    func next() {
        guard isPresented else { return }
        if isLastStep {
            finish(as: .completed)
        } else {
            index += 1
        }
    }

    func back() {
        guard isPresented, canGoBack else { return }
        index -= 1
    }

    func skip() {
        guard isPresented else { return }
        finish(as: .skipped)
    }

    func dismissManualReplay() {
        guard isManualReplay else { return }
        reset()
    }

    private func begin(plan: [OnboardingStep], userID: String, version: Int?, manual: Bool) {
        steps = plan
        index = 0
        self.userID = userID
        self.version = version
        isManualReplay = manual
        isPresented = true
    }

    private func finish(as status: OnboardingStatus) {
        let shouldPersist = !isManualReplay
        let finishingUserID = userID
        let finishingVersion = version

        if shouldPersist, let finishingUserID, let finishingVersion {
            defaults.set(true, forKey: suppressionKey(userID: finishingUserID,
                                                       version: finishingVersion))
            defaults.set(status.rawValue,
                         forKey: pendingKey(userID: finishingUserID,
                                            version: finishingVersion))
        }
        reset()

        guard shouldPersist,
              let finishingUserID,
              let finishingVersion else { return }
        retryPendingDecision(status, userID: finishingUserID, version: finishingVersion)
    }

    private func reset() {
        steps = []
        index = 0
        userID = nil
        version = nil
        isManualReplay = false
        isPresented = false
    }

    private func isLocallySuppressed(userID: String, version: Int) -> Bool {
        defaults.bool(forKey: suppressionKey(userID: userID, version: version))
    }

    private func suppressionKey(userID: String, version: Int) -> String {
        "vici.onboarding.suppressed.\(userID).v\(version)"
    }

    private func pendingKey(userID: String, version: Int) -> String {
        "vici.onboarding.pending.\(userID).v\(version)"
    }

    private func pendingDecision(userID: String, version: Int) -> OnboardingStatus? {
        guard let raw = defaults.string(forKey: pendingKey(userID: userID, version: version)) else {
            return nil
        }
        return OnboardingStatus(rawValue: raw)
    }

    private func retryPendingDecision(_ status: OnboardingStatus,
                                      userID: String,
                                      version: Int) {
        guard status == .completed || status == .skipped else { return }
        Task {
            do {
                try await APIClient.shared.updateOnboarding(
                    status: status,
                    version: version,
                    userID: userID
                )
                defaults.removeObject(forKey: pendingKey(userID: userID, version: version))
            } catch {
                // Keep the compact pending decision for the next authenticated
                // session. No customer data or credential is stored here.
            }
        }
    }
}
