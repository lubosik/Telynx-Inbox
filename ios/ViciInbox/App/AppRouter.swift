import Foundation
import Combine

/// The five stable identities in the iPhone tab bar.
///
/// These are values rather than positions. Analytics can disappear when a role
/// loses `analytics.read`, without renumbering any other tab.
enum AppTab: Int, Codable, Hashable {
    case inbox
    case contacts
    case growth
    case calls
    case analytics
}

/// The three panes that share the Growth tab.
enum GrowthSection: Int, Codable, Hashable, CaseIterable, Identifiable {
    case automations
    case campaigns
    case audiences

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .automations: return "Automations"
        case .campaigns: return "Campaigns"
        case .audiences: return "Audiences"
        }
    }
}

/// One typed destination vocabulary for the whole signed-in application.
///
/// Routes contain stable scalar identity only. They deliberately do not carry a
/// message, customer record, attribution record, internal note, or invite/reset
/// bearer token. A destination re-reads its authoritative record by identifier.
/// Codable makes restoration possible later, but paths are not persisted today:
/// a conversation is identified by a phone number, which is personal data and
/// needs a deliberate protected-storage and retention decision first.
enum AppRoute: Codable, Hashable {
    // Tab roots. These select a screen without adding a back-stack entry.
    case inbox
    case contacts
    case growth(GrowthSection)
    case calls
    case analytics

    // Inbox and Contacts.
    case conversation(phone: String)
    case referral(id: String, phone: String)
    case contact(phone: String)
    case businessLine

    // Growth.
    case automationHistory(id: String)
    case activity(category: String)
    case opportunities
    case doNotContact
    case campaignProposals
    case campaign(id: String)
    case segment(id: String, name: String?)
    case segmentPeople(id: String, name: String?)

    // Analytics. Dates are YYYY-MM-DD values, not locale-formatted text.
    case analyticsAttributions(period: String,
                               start: String?,
                               end: String?,
                               scope: String,
                               category: String?)
    case attributionMethodology
    case campaignAttributions(campaignID: String)

    // The account sheet has its own typed path.
    case account
    case assistant
    case referrals
    case settings
    case accountSettings
    case appearanceSettings
    case notificationSettings
    case assistantSettings
    case team
    case password
    case securitySettings
    case messagingCallingSettings
    case advancedSettings
    case diagnostics
    case help
    case about

    /// The main tab a route belongs to, or nil for account-sheet routes.
    var tab: AppTab? {
        switch self {
        case .inbox, .conversation, .referral:
            return .inbox
        case .contacts, .contact, .businessLine:
            return .contacts
        case .growth, .automationHistory, .activity, .opportunities, .doNotContact,
             .campaignProposals, .campaign, .segment, .segmentPeople,
             .campaignAttributions:
            return .growth
        case .calls:
            return .calls
        case .analytics, .analyticsAttributions, .attributionMethodology:
            return .analytics
        case .account, .assistant, .referrals, .settings, .accountSettings, .appearanceSettings,
             .notificationSettings, .assistantSettings, .team, .password, .securitySettings,
             .messagingCallingSettings, .advancedSettings, .diagnostics,
             .help, .about:
            return nil
        }
    }

    /// The Growth pane that must be visible before pushing this route.
    var growthSection: GrowthSection? {
        switch self {
        case .growth(let section): return section
        case .automationHistory, .activity: return .automations
        case .opportunities, .doNotContact: return .audiences
        case .campaignProposals, .campaign, .campaignAttributions: return .campaigns
        case .segment, .segmentPeople: return .audiences
        default: return nil
        }
    }

    var isTabRoot: Bool {
        switch self {
        case .inbox, .contacts, .growth, .calls, .analytics: return true
        default: return false
        }
    }

    var isAccountRoute: Bool { tab == nil }

    /// Empty identifiers are malformed. Refusing without moving is safer than
    /// opening a nearby list that looks like the requested destination.
    var isWellFormed: Bool {
        func present(_ value: String) -> Bool {
            !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }

        switch self {
        case .conversation(let phone), .contact(let phone):
            return present(phone)
        case .referral(let id, let phone):
            return present(id) && present(phone)
        case .automationHistory(let id), .campaign(let id):
            return present(id)
        case .segment(let id, _), .segmentPeople(let id, _):
            return present(id)
        case .activity(let category):
            return present(category)
        case .analyticsAttributions(let period, _, _, let scope, _):
            return present(period) && present(scope)
        case .campaignAttributions(let campaignID):
            return present(campaignID)
        default:
            return true
        }
    }
}

/// Effective permissions relevant to navigation. The server remains the real
/// authorisation boundary; this only prevents the app from moving to a screen
/// that the current session already knows it cannot read.
struct AppNavigationAccess: Equatable {
    let analytics: Bool
    let campaigns: Bool
    /// Offers/proposals are backed by a `campaigns.manage` endpoint. This is
    /// distinct from the read permission used by segments and campaign detail.
    let campaignsManage: Bool
    let activity: Bool
    let team: Bool
    let referrals: Bool
    let assistant: Bool

    init(analytics: Bool,
         campaigns: Bool,
         campaignsManage: Bool = false,
         activity: Bool,
         team: Bool,
         referrals: Bool,
         assistant: Bool) {
        self.analytics = analytics
        self.campaigns = campaigns
        self.campaignsManage = campaignsManage
        self.activity = activity
        self.team = team
        self.referrals = referrals
        self.assistant = assistant
    }

    static let unrestricted = AppNavigationAccess(
        analytics: true,
        campaigns: true,
        campaignsManage: true,
        activity: true,
        team: true,
        referrals: true,
        assistant: true
    )

    func permits(_ route: AppRoute) -> Bool {
        switch route {
        case .analytics, .analyticsAttributions, .attributionMethodology:
            return analytics
        case .growth(.campaigns), .growth(.audiences),
             .opportunities, .doNotContact, .campaign, .segment, .segmentPeople,
             .campaignAttributions:
            // Gated explicitly rather than left to the default. Who a business
            // refuses to contact is campaign information, and the default here
            // is permit.
            return campaigns
        case .campaignProposals:
            return campaignsManage
        case .activity:
            return activity
        case .team:
            return team
        case .referral, .referrals:
            return referrals
        case .assistant:
            return assistant
        default:
            return true
        }
    }
}

/// Turns a notification payload into one atomic destination.
///
/// The notification delegate extracts strings from `[AnyHashable: Any]`; this
/// Foundation-only parser then resolves the result without UIKit, making its
/// compatibility aliases and conflict behavior directly testable.
enum AppNotificationRouteParser {
    static func route(screen rawScreen: String?,
                      phone rawPhone: String?,
                      campaignID rawCampaignID: String?,
                      segmentID rawSegmentID: String?,
                      referralID rawReferralID: String? = nil) -> AppRoute? {
        let screen = clean(rawScreen)?.lowercased()
        let phone = clean(rawPhone)
        let campaignID = clean(rawCampaignID)
        let segmentID = clean(rawSegmentID)
        let referralID = clean(rawReferralID)

        // Two exact record identities in one payload are contradictory. Do not
        // guess which notification the server meant.
        let exactIdentities = [campaignID, segmentID, referralID].compactMap { $0 }
        guard exactIdentities.count <= 1 else { return nil }

        if let referralID {
            guard let phone,
                  screen == nil || screen == "conversation" || screen == "inbox" || screen == "messages" else {
                return nil
            }
            return .referral(id: referralID, phone: phone)
        }

        if let campaignID {
            guard screen == nil || screen == "campaigns" || screen == "growth" else { return nil }
            return .campaign(id: campaignID)
        }
        if let segmentID {
            guard screen == nil || screen == "segments" || screen == "audiences" || screen == "growth" else {
                return nil
            }
            return .segment(id: segmentID, name: nil)
        }

        switch screen {
        case "analytics": return .analytics
        case "inbox", "messages":
            return phone.map { .conversation(phone: $0) } ?? .inbox
        case "contacts": return .contacts
        case "automations", "activity": return .growth(.automations)
        case "growth": return .growth(.automations)
        case "campaigns": return .growth(.campaigns)
        case "segments", "audiences": return .growth(.audiences)
        case "calls": return .calls
        case nil:
            return phone.map { .conversation(phone: $0) }
        default:
            // Preserve the useful half of a legacy payload that also happens to
            // carry an unknown screen. With no phone, unknown means no movement.
            return phone.map { .conversation(phone: $0) }
        }
    }

    enum ForegroundKind: Equatable {
        case message
        case campaign
        case navigation
    }

    /// Whether a foreground push changes an app badge. A named destination is
    /// not a customer message, including analytics, calls and future screens.
    static func foregroundKind(screen rawScreen: String?,
                               campaignID rawCampaignID: String?,
                               segmentID rawSegmentID: String?,
                               referralID rawReferralID: String? = nil) -> ForegroundKind {
        let screen = clean(rawScreen)?.lowercased()
        if clean(rawReferralID) != nil { return .navigation }
        if clean(rawCampaignID) != nil || clean(rawSegmentID) != nil ||
            screen == "campaigns" || screen == "segments" || screen == "audiences" {
            return .campaign
        }
        if screen != nil { return .navigation }
        return .message
    }

    private static func clean(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// App-level navigation state. Voice, push notifications, onboarding and future
/// universal links all call this object rather than mutating view-local state.
@MainActor
final class AppRouter: ObservableObject {
    static let shared = AppRouter()

    @Published var selectedTab: AppTab = .inbox
    @Published var growthSection: GrowthSection = .automations

    @Published var inboxPath: [AppRoute] = []
    @Published var contactsPath: [AppRoute] = []
    @Published var growthPath: [AppRoute] = []
    @Published var callsPath: [AppRoute] = []
    @Published var analyticsPath: [AppRoute] = []

    @Published var isAccountPresented = false
    @Published var accountPath: [AppRoute] = []
    @Published private(set) var pendingRoute: AppRoute?

    private init() {}

    /// The exact visible destination in the signed-in tab hierarchy.
    ///
    /// The account sheet is deliberately not included. Assistant is presented
    /// in that sheet, so retaining the underlying route is what lets a phrase
    /// such as "the people in it" refer only to the segment the operator was
    /// actually viewing. No list item is guessed when the current route is not
    /// a segment.
    var currentMainRoute: AppRoute {
        switch selectedTab {
        case .inbox:
            return inboxPath.last ?? .inbox
        case .contacts:
            return contactsPath.last ?? .contacts
        case .growth:
            return growthPath.last ?? .growth(growthSection)
        case .calls:
            return callsPath.last ?? .calls
        case .analytics:
            return analyticsPath.last ?? .analytics
        }
    }

    /// Queues cold-launch navigation until the signed-in tab hierarchy exists.
    func queue(_ route: AppRoute) {
        guard route.isWellFormed else { return }
        pendingRoute = route
    }

    func discardPendingRoute() {
        pendingRoute = nil
    }

    /// Processes at most one queued request. A denied or malformed request is
    /// consumed without moving, so a stale push cannot reopen on every launch.
    @discardableResult
    func processPending(access: AppNavigationAccess) -> Bool {
        guard let route = pendingRoute else { return false }
        pendingRoute = nil
        return open(route, access: access)
    }

    /// Opens one destination atomically. A detail route resets that tab's path,
    /// matching the existing notification behavior and avoiding a back stack
    /// assembled from whatever the operator happened to be viewing beforehand.
    @discardableResult
    func open(_ route: AppRoute,
              access: AppNavigationAccess = .unrestricted,
              resetPath: Bool = true) -> Bool {
        guard route.isWellFormed, access.permits(route) else { return false }

        if route.isAccountRoute {
            return openAccount(route, resetPath: resetPath)
        }

        guard let tab = route.tab else { return false }
        selectedTab = tab
        if let section = route.growthSection { growthSection = section }

        guard !route.isTabRoot else {
            if resetPath { setPath([], for: tab) }
            return true
        }

        if resetPath {
            setPath([route], for: tab)
        } else {
            append(route, to: tab)
        }
        return true
    }

    func presentAccount() {
        accountPath = []
        isAccountPresented = true
    }

    /// Open the assistant directly, without the operator passing through the
    /// account menu to get there.
    ///
    /// The assistant is a destination INSIDE the account sheet, which is why
    /// closing it used to reveal Settings: the assistant was never the thing on
    /// top, the account menu was, and dismissing one screen simply showed the
    /// one underneath. Somebody who taps the floating orb wants the
    /// conversation, not the settings screen it happens to live behind.
    func presentAssistant() {
        accountPath = [.assistant]
        isAccountPresented = true
    }

    func dismissAccount() {
        isAccountPresented = false
        accountPath = []
    }

    /// Navigation can contain customer phone numbers. Explicit sign-out must
    /// remove every path before another person can sign into this iPhone.
    func resetForSignOut() {
        selectedTab = .inbox
        growthSection = .automations
        inboxPath = []
        contactsPath = []
        growthPath = []
        callsPath = []
        analyticsPath = []
        accountPath = []
        isAccountPresented = false
        pendingRoute = nil
    }

    /// Removes state that the current role can no longer display.
    func sanitize(access: AppNavigationAccess) {
        if !access.analytics {
            analyticsPath = []
            if selectedTab == .analytics { selectedTab = .inbox }
        }
        if !access.campaigns {
            growthPath.removeAll { route in
                switch route {
                case .opportunities, .campaign, .segment, .segmentPeople,
                     .campaignAttributions: return true
                default: return false
                }
            }
            if growthSection != .automations { growthSection = .automations }
        }
        if !access.campaignsManage {
            growthPath.removeAll { $0 == .campaignProposals }
        }
        if !access.activity {
            growthPath.removeAll {
                if case .activity = $0 { return true }
                return false
            }
            accountPath.removeAll {
                if case .activity = $0 { return true }
                return false
            }
        }
        if !access.team { accountPath.removeAll { $0 == .team } }
        if !access.referrals {
            inboxPath.removeAll {
                if case .referral = $0 { return true }
                return false
            }
            accountPath.removeAll { $0 == .referrals }
        }
        if !access.assistant { accountPath.removeAll { $0 == .assistant } }
    }

    private func openAccount(_ route: AppRoute, resetPath: Bool) -> Bool {
        let path: [AppRoute]
        switch route {
        case .account:
            path = []
        case .notificationSettings:
            path = [.settings, .notificationSettings]
        case .assistantSettings:
            path = [.settings, .assistantSettings]
        case .diagnostics:
            path = [.settings, .advancedSettings, .diagnostics]
        case .referrals:
            path = [.referrals]
        case .accountSettings, .appearanceSettings, .securitySettings,
             .messagingCallingSettings, .advancedSettings, .help, .about:
            path = [.settings, route]
        default:
            path = [route]
        }

        if resetPath { accountPath = path }
        else { accountPath.append(contentsOf: path) }
        isAccountPresented = true
        return true
    }

    private func setPath(_ path: [AppRoute], for tab: AppTab) {
        switch tab {
        case .inbox: inboxPath = path
        case .contacts: contactsPath = path
        case .growth: growthPath = path
        case .calls: callsPath = path
        case .analytics: analyticsPath = path
        }
    }

    private func append(_ route: AppRoute, to tab: AppTab) {
        switch tab {
        case .inbox: inboxPath.append(route)
        case .contacts: contactsPath.append(route)
        case .growth: growthPath.append(route)
        case .calls: callsPath.append(route)
        case .analytics: analyticsPath.append(route)
        }
    }
}
