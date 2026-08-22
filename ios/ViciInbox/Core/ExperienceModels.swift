import Foundation

enum OnboardingStatus: String, Codable, Hashable {
    case ineligible
    case notStarted = "not_started"
    case completed
    case skipped
}

/// Optional server-owned state. Automatic onboarding is deliberately
/// fail-closed: an older server omits this object, and an omitted or partial
/// object must never make an existing account look new.
struct AccountOnboardingState: Codable, Hashable {
    let eligible: Bool?
    let version: Int?
    let status: OnboardingStatus?

    var automaticTourVersion: Int? {
        guard eligible == true,
              status == .notStarted,
              let version,
              version > 0 else { return nil }
        return version
    }
}

enum OnboardingTarget: String, Hashable {
    case inbox
    case contacts
    case growth
    case campaigns
    case calls
    case analytics
    case revenueAttribution
    case account
}

struct OnboardingStep: Identifiable, Hashable {
    let id: String
    let target: OnboardingTarget
    let title: String
    let detail: String
}

enum OnboardingPlan {
    /// Builds the tour from effective permissions, not a role label. A custom
    /// permission deny therefore removes the matching step as soon as the
    /// server refreshes the account.
    static func steps(for user: AuthUser) -> [OnboardingStep] {
        let permissions = user.permissionSet
        var result: [OnboardingStep] = [
            OnboardingStep(
                id: "inbox",
                target: .inbox,
                title: "Your shared inbox",
                detail: "Customer conversations and unread messages live here."
            ),
            OnboardingStep(
                id: "contacts",
                target: .contacts,
                title: "Customer context",
                detail: "Find contact details, orders and the history behind each conversation."
            )
        ]

        if permissions.contains(Permission.campaignsRead) {
            result.append(OnboardingStep(
                id: "growth",
                target: .growth,
                title: "Growth",
                detail: "Review live automations and the revenue opportunities available to your role."
            ))
        }

        if permissions.contains(Permission.campaignsRead) {
            result.append(OnboardingStep(
                id: "campaigns",
                target: .campaigns,
                title: "Campaign review",
                detail: permissions.contains(Permission.campaignsApprove)
                    ? "Review the audience, reason and message before a campaign can send."
                    : "See what customers received so you can handle their replies with context."
            ))
        }

        if permissions.contains(Permission.analyticsRead) {
            result.append(OnboardingStep(
                id: "analytics",
                target: .analytics,
                title: "Measured revenue impact",
                detail: "See verified messaging, calling and revenue performance."
            ))
            result.append(OnboardingStep(
                id: "revenue-attribution",
                target: .revenueAttribution,
                title: "Transparent attribution",
                detail: "See why revenue is Direct, Strong, Influenced or Unattributed."
            ))
        } else {
            result.append(OnboardingStep(
                id: "calls",
                target: .calls,
                title: "Business calling",
                detail: "Make calls and review call history from the business line."
            ))
        }

        result.append(OnboardingStep(
            id: "account",
            target: .account,
            title: "Account and Settings",
            detail: "Use the account button for appearance, notifications, help and the settings available to you. You're all set, \(firstName(from: user.name))."
        ))
        return result
    }

    private static func firstName(from displayName: String) -> String {
        displayName
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
            .first
            .map(String.init) ?? "there"
    }
}

struct WelcomeRequest: Identifiable, Equatable {
    let id = UUID()
    let userID: String
    let firstName: String
}
