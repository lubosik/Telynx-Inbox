import Foundation

@main
struct AppRouterSmoke {
    @MainActor
    static func main() throws {
        let route = AppRoute.segment(id: "segment-42", name: "Recent buyers")
        let encoded = try JSONEncoder().encode(route)
        let decoded = try JSONDecoder().decode(AppRoute.self, from: encoded)
        precondition(decoded == route, "AppRoute must round-trip through Codable")

        precondition(
            AppNotificationRouteParser.route(
                screen: "segments", phone: nil, campaignID: nil, segmentID: nil
            ) == .growth(.audiences),
            "a segment digest must open Growth/Audiences"
        )
        precondition(
            AppNotificationRouteParser.route(
                screen: "segments", phone: nil, campaignID: nil, segmentID: "seg-1"
            ) == .segment(id: "seg-1", name: nil),
            "a segment notification must open the exact segment"
        )
        precondition(
            AppNotificationRouteParser.route(
                screen: "campaigns", phone: nil, campaignID: "campaign-1", segmentID: "segment-1"
            ) == nil,
            "a contradictory payload must not guess"
        )
        precondition(
            AppNotificationRouteParser.foregroundKind(
                screen: "analytics", campaignID: nil, segmentID: nil
            ) == .navigation,
            "a named analytics destination must not inflate message unread"
        )
        precondition(
            AppNotificationRouteParser.foregroundKind(
                screen: nil, campaignID: nil, segmentID: nil
            ) == .message,
            "a legacy unnamed message notification remains a message"
        )
        precondition(
            AppNotificationRouteParser.route(
                screen: "conversation", phone: "+13055550123",
                campaignID: nil, segmentID: nil, referralID: "referral-1"
            ) == .referral(id: "referral-1", phone: "+13055550123"),
            "a referral push must preserve its referral and conversation identities atomically"
        )
        precondition(
            AppNotificationRouteParser.route(
                screen: "conversation", phone: nil,
                campaignID: nil, segmentID: nil, referralID: "referral-1"
            ) == nil,
            "a referral without its conversation must not route to a nearby screen"
        )
        precondition(
            AppNotificationRouteParser.foregroundKind(
                screen: "conversation", campaignID: nil,
                segmentID: nil, referralID: "referral-1"
            ) == .navigation,
            "an internal referral must never inflate customer-message unread"
        )

        let router = AppRouter.shared
        router.inboxPath = []
        router.contactsPath = []
        router.growthPath = []
        router.callsPath = []
        router.analyticsPath = []
        router.accountPath = []
        router.isAccountPresented = false
        router.selectedTab = .inbox
        router.growthSection = .automations
        router.discardPendingRoute()

        router.queue(.segment(id: "segment-42", name: nil))
        precondition(router.processPending(access: .unrestricted))
        precondition(router.selectedTab == .growth)
        precondition(router.growthSection == .audiences)
        precondition(router.growthPath == [.segment(id: "segment-42", name: nil)])
        precondition(router.pendingRoute == nil, "a route is consumed exactly once")

        let denied = AppNavigationAccess(
            analytics: false, campaigns: true, activity: true, team: true,
            referrals: true, assistant: true
        )
        router.selectedTab = .contacts
        router.queue(.analytics)
        precondition(!router.processPending(access: denied))
        precondition(router.selectedTab == .contacts, "a denied route must not move")
        precondition(router.pendingRoute == nil, "a denied stale push must be consumed")

        precondition(router.open(.notificationSettings))
        precondition(router.isAccountPresented)
        precondition(router.accountPath == [.settings, .notificationSettings])

        router.inboxPath = [.conversation(phone: "+15555550123")]
        router.queue(.campaign(id: "private-campaign"))
        router.resetForSignOut()
        precondition(router.inboxPath.isEmpty)
        precondition(router.accountPath.isEmpty)
        precondition(router.pendingRoute == nil)
        precondition(router.selectedTab == .inbox)

        // A source-permission revocation must remove a read-only evidence
        // screen and its already-loaded portfolio from the visible path.
        precondition(router.open(.opportunities))
        precondition(router.growthPath == [.opportunities])
        router.sanitize(access: AppNavigationAccess(
            analytics: true, campaigns: false, activity: true, team: true,
            referrals: true, assistant: true
        ))
        precondition(!router.growthPath.contains(.opportunities))
        precondition(router.growthSection == .automations)

        print("App router smoke: OK")
    }
}
