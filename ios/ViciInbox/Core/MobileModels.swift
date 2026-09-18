import Foundation

/// Supabase identifiers are not consistent across the existing tables: some
/// arrive as JSON numbers and others as UUID strings. Keep that inconsistency
/// at the API boundary instead of leaking it into the views.
struct FlexibleID: Codable, Hashable, Identifiable {
    let rawValue: String
    var id: String { rawValue }

    init(_ rawValue: String) { self.rawValue = rawValue }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            rawValue = value
        } else if let value = try? container.decode(Int.self) {
            rawValue = String(value)
        } else if let value = try? container.decode(Double.self) {
            rawValue = String(format: "%.0f", value)
        } else {
            throw DecodingError.typeMismatch(
                FlexibleID.self,
                DecodingError.Context(codingPath: decoder.codingPath,
                                      debugDescription: "Expected a string or numeric identifier")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let integer = Int(rawValue) { try container.encode(integer) }
        else { try container.encode(rawValue) }
    }
}

struct MediaAttachment: Codable, Hashable, Identifiable {
    let url: String
    var id: String { url }

    init(url: String) { self.url = url }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            url = value
            return
        }
        let object = try container.decode([String: String].self)
        guard let value = object["url"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.url,
                DecodingError.Context(codingPath: decoder.codingPath,
                                      debugDescription: "Media attachment has no URL")
            )
        }
        url = value
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(["url": url])
    }

    private enum CodingKeys: String, CodingKey { case url }
}

struct MessageReaction: Codable, Hashable, Identifiable {
    let type: String
    let source: String?
    let at: String?
    var id: String { "\(type)-\(source ?? "unknown")" }
}

struct MessageRecord: Codable, Identifiable, Hashable {
    let recordID: FlexibleID?
    let telnyxMessageID: String?
    let contactPhone: String
    let direction: String
    let body: String?
    let status: String?
    let mediaURLs: [MediaAttachment]?
    let replyToMessageID: FlexibleID?
    let reactions: [MessageReaction]?
    let createdAt: String?

    var id: String {
        if let recordID { return recordID.rawValue }
        if let telnyxMessageID { return telnyxMessageID }
        let media = (mediaURLs ?? []).map(\.url).joined(separator: "|")
        return "\(contactPhone)|\(createdAt ?? "")|\(direction)|\(body ?? "")|\(media)"
    }
    var isInbound: Bool { direction == "inbound" }
    var numericID: Int? { recordID.flatMap { Int($0.rawValue) } }

    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case telnyxMessageID = "telnyx_message_id"
        case contactPhone = "contact_phone"
        case direction, body, status, reactions
        case mediaURLs = "media_urls"
        case replyToMessageID = "reply_to_message_id"
        case createdAt = "created_at"
    }
}

struct ConversationSummary: Codable, Identifiable, Hashable {
    let recordID: FlexibleID?
    let phone: String
    let firstName: String?
    let lastName: String?
    let name: String?
    let displayNameValue: String?
    let email: String?
    let notes: String?
    let avatarURL: String?
    let unreadCount: Int?
    let lastSeen: String?
    let lastMessage: MessagePreview?
    let latestOrderStatus: String?
    let latestOrderDate: String?
    let latestOrderID: FlexibleID?

    var id: String { phone }
    var displayName: String {
        let joined = [firstName, lastName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        return displayNameValue ?? (!joined.isEmpty ? joined : (name?.isEmpty == false ? name! : PhoneFormatter.pretty(phone)))
    }
    var hasSavedName: Bool {
        [firstName, lastName, name].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .contains { !$0.isEmpty }
    }
    var initials: String {
        let pieces = displayName.split(separator: " ")
        return String(pieces.prefix(2).compactMap(\.first)).uppercased()
    }

    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case phone
        case firstName = "first_name"
        case lastName = "last_name"
        case name
        case displayNameValue = "display_name"
        case email, notes
        case avatarURL = "avatar_url"
        case unreadCount = "unread_count"
        case lastSeen = "last_seen"
        case lastMessage
        case latestOrderStatus = "latest_order_status"
        case latestOrderDate = "latest_order_date"
        case latestOrderID = "latest_order_id"
    }
}

struct MessagePreview: Codable, Hashable {
    let body: String?
    let direction: String?
    let createdAt: String?
    let mediaURLs: [MediaAttachment]?

    enum CodingKeys: String, CodingKey {
        case body, direction
        case createdAt = "created_at"
        case mediaURLs = "media_urls"
    }
}

struct ContactPage: Codable {
    let contacts: [ConversationSummary]
    let page: Int
    let total: Int?
    let hasMore: Bool
}

struct ContactDetailResponse: Codable {
    let contact: ConversationSummary
    let orders: [OrderRecord]
    let totalOrders: Int?
    let totalSpent: FlexibleDecimal?
    let intelligence: CustomerIntelligence?
    let suggestions: [CampaignSuggestion]?

    enum CodingKeys: String, CodingKey {
        case contact, orders, intelligence, suggestions
        case totalOrders = "total_orders"
        case totalSpent = "total_spent"
    }
}

struct OrderRecord: Codable, Identifiable, Hashable {
    let recordID: FlexibleID?
    let wooOrderID: FlexibleID?
    let status: String?
    let total: FlexibleDecimal?
    let items: [OrderItem]?
    let createdAt: String?
    let trackingNumber: String?
    let carrier: String?
    let shippedAt: String?

    var id: String { recordID?.rawValue ?? wooOrderID?.rawValue ?? UUID().uuidString }

    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case wooOrderID = "woo_order_id"
        case status, total, items
        case createdAt = "created_at"
        case trackingNumber = "tracking_number"
        case carrier
        case shippedAt = "shipped_at"
    }
}

struct OrderItem: Codable, Hashable {
    let name: String?
    let quantity: Int?
}

struct FlexibleDecimal: Codable, Hashable {
    let value: Decimal
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let decimal = try? container.decode(Decimal.self) { value = decimal }
        else if let string = try? container.decode(String.self), let decimal = Decimal(string: string) { value = decimal }
        else { throw DecodingError.typeMismatch(Decimal.self, .init(codingPath: decoder.codingPath, debugDescription: "Expected money as number or string")) }
    }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(value) }
    var currencyText: String { NSDecimalNumber(decimal: value).stringValue }
}

struct CustomerIntelligence: Codable, Hashable {
    let summary: String?
    let sentiment: String?
    let interests: [String]?
    let updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case summary, sentiment, interests
        case updatedAt = "updated_at"
    }
}

struct CampaignSuggestion: Codable, Identifiable, Hashable {
    let recordID: FlexibleID
    let suggestedMessage: String?
    let reason: String?
    let status: String?
    var id: String { recordID.rawValue }

    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case suggestedMessage = "suggested_message"
        case reason, status
    }
}

struct ActivityStats: Codable {
    let pending: Int
    let sentToday: Int
    let failedToday: Int
    let cancelledToday: Int
    let updatedAt: String?
}

struct ActivityPage: Codable { let items: [ActivityRecord]; let page: Int; let hasMore: Bool }

struct ActivityRecord: Codable, Identifiable, Hashable {
    let recordID: FlexibleID
    let orderID: FlexibleID?
    let phone: String?
    let flowType: String?
    let messageBody: String?
    let sendAt: String?
    let sentAt: String?
    let status: String?
    let contactName: String?
    let telnyxMessageID: String?

    var id: String { recordID.rawValue }
    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case orderID = "order_id"
        case phone
        case flowType = "flow_type"
        case messageBody = "message_body"
        case sendAt = "send_at"
        case sentAt = "sent_at"
        case status
        case contactName = "contact_name"
        case telnyxMessageID = "telnyx_message_id"
    }
}

// MARK: - Abandoned cart recovery

/// A small dynamic-key decoder keeps this client compatible while the growth
/// endpoint moves from database-shaped snake_case records to the documented
/// camelCase API. It is intentionally scoped to this feature so it cannot make
/// unrelated wire contracts silently permissive.
private struct CartRecoveryWireKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil
    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private extension KeyedDecodingContainer where Key == CartRecoveryWireKey {
    func first<T: Decodable>(_ type: T.Type, _ names: String...) -> T? {
        for name in names {
            guard let key = CartRecoveryWireKey(stringValue: name) else { continue }
            guard contains(key), (try? decodeNil(forKey: key)) != true else { continue }
            if let value = try? decode(type, forKey: key) { return value }
        }
        return nil
    }
}

struct CartRecoveryDashboard: Decodable, Hashable {
    let mode: String
    let metrics: CartRecoveryMetrics
    let automation: CartRecoveryAutomationSnapshot?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        mode = values.first(String.self, "mode") ?? "unavailable"
        metrics = values.first(CartRecoveryMetrics.self, "metrics") ?? .empty
        automation = values.first(CartRecoveryAutomationSnapshot.self, "automation")
    }
}

struct CartRecoveryAutomationSnapshot: Decodable, Hashable {
    let enabled: Bool
    let smsDelayMinutes: Int
    let pushEnabled: Bool
    let pushDelayHours: Int
    let voiceEnabled: Bool
    let voiceDelayMinutes: Int

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        enabled = values.first(Bool.self, "enabled") ?? false
        smsDelayMinutes = values.first(Int.self, "smsDelayMinutes", "sms_delay_minutes") ?? 45
        pushEnabled = values.first(Bool.self, "pushEnabled", "push_enabled") ?? false
        pushDelayHours = values.first(Int.self, "pushDelayHours", "push_delay_hours") ?? 48
        voiceEnabled = values.first(Bool.self, "voiceEnabled", "voice_enabled") ?? false
        voiceDelayMinutes = values.first(Int.self, "voiceDelayMinutes", "voice_delay_minutes") ?? 180
    }
}

struct CartRecoveryMetrics: Decodable, Hashable {
    let abandonedCartsIdentified: Int
    let smsEligible: Int
    let active: Int
    let queued: Int
    let sent: Int
    let delivered: Int
    let clicked: Int
    let replied: Int
    let aiDrafts: Int
    let pushScheduled: Int
    let pushBlocked: Int
    let pushSent: Int
    let pushClicked: Int
    let voiceEligible: Int
    let voiceQueued: Int
    let voiceInitiated: Int
    let voiceHumanDetected: Int
    let voiceVoicemailsPlayed: Int
    let voiceTransfersConnected: Int
    let voiceOptOuts: Int
    let converted: Int
    let recoveredOrders: Int
    let recoveredRevenue: FlexibleDecimal?
    let currency: String
    let topReasons: [CartRecoveryReasonMetric]

    static let empty = CartRecoveryMetrics(abandonedCartsIdentified: 0, smsEligible: 0,
                                           active: 0, queued: 0, sent: 0,
                                           delivered: 0, clicked: 0, replied: 0, aiDrafts: 0,
                                           pushScheduled: 0, pushBlocked: 0,
                                           pushSent: 0, pushClicked: 0,
                                           voiceEligible: 0, voiceQueued: 0,
                                           voiceInitiated: 0, voiceHumanDetected: 0,
                                           voiceVoicemailsPlayed: 0, voiceTransfersConnected: 0,
                                           voiceOptOuts: 0,
                                           converted: 0, recoveredOrders: 0,
                                           recoveredRevenue: nil, currency: "USD",
                                           topReasons: [])

    private init(abandonedCartsIdentified: Int, smsEligible: Int,
                 active: Int, queued: Int, sent: Int, delivered: Int, clicked: Int,
                 replied: Int, aiDrafts: Int, pushScheduled: Int, pushBlocked: Int,
                 pushSent: Int, pushClicked: Int,
                 voiceEligible: Int, voiceQueued: Int, voiceInitiated: Int,
                 voiceHumanDetected: Int, voiceVoicemailsPlayed: Int,
                 voiceTransfersConnected: Int, voiceOptOuts: Int,
                 converted: Int, recoveredOrders: Int,
                 recoveredRevenue: FlexibleDecimal?, currency: String,
                 topReasons: [CartRecoveryReasonMetric]) {
        self.abandonedCartsIdentified = abandonedCartsIdentified
        self.smsEligible = smsEligible
        self.active = active
        self.queued = queued
        self.sent = sent
        self.delivered = delivered
        self.clicked = clicked
        self.replied = replied
        self.aiDrafts = aiDrafts
        self.pushScheduled = pushScheduled
        self.pushBlocked = pushBlocked
        self.pushSent = pushSent
        self.pushClicked = pushClicked
        self.voiceEligible = voiceEligible
        self.voiceQueued = voiceQueued
        self.voiceInitiated = voiceInitiated
        self.voiceHumanDetected = voiceHumanDetected
        self.voiceVoicemailsPlayed = voiceVoicemailsPlayed
        self.voiceTransfersConnected = voiceTransfersConnected
        self.voiceOptOuts = voiceOptOuts
        self.converted = converted
        self.recoveredOrders = recoveredOrders
        self.recoveredRevenue = recoveredRevenue
        self.currency = currency
        self.topReasons = topReasons
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        abandonedCartsIdentified = values.first(Int.self, "abandonedCartsIdentified", "abandoned_carts_identified") ?? 0
        smsEligible = values.first(Int.self, "smsEligible", "sms_eligible") ?? 0
        active = values.first(Int.self, "active", "activeJourneys", "active_journeys") ?? 0
        queued = values.first(Int.self, "queued", "queuedJourneys", "queued_journeys") ?? 0
        sent = values.first(Int.self, "sent", "messagesSent", "messages_sent") ?? 0
        delivered = values.first(Int.self, "delivered", "messagesDelivered", "messages_delivered") ?? 0
        clicked = values.first(Int.self, "clicked", "linkClicks", "link_clicks") ?? 0
        replied = values.first(Int.self, "replied", "replies") ?? 0
        aiDrafts = values.first(Int.self, "aiDrafts", "ai_drafts") ?? 0
        pushScheduled = values.first(Int.self, "pushScheduled", "push_scheduled") ?? 0
        pushBlocked = values.first(Int.self, "pushBlocked", "push_blocked") ?? 0
        pushSent = values.first(Int.self, "pushSent", "push_sent") ?? 0
        pushClicked = values.first(Int.self, "pushClicked", "push_clicked") ?? 0
        voiceEligible = values.first(Int.self, "voiceEligible", "voice_eligible") ?? 0
        voiceQueued = values.first(Int.self, "voiceQueued", "voice_queued") ?? 0
        voiceInitiated = values.first(Int.self, "voiceInitiated", "voice_initiated") ?? 0
        voiceHumanDetected = values.first(Int.self, "voiceHumanDetected", "voice_human_detected") ?? 0
        voiceVoicemailsPlayed = values.first(Int.self, "voiceVoicemailsPlayed", "voice_voicemails_played") ?? 0
        voiceTransfersConnected = values.first(Int.self, "voiceTransfersConnected", "voice_transfers_connected") ?? 0
        voiceOptOuts = values.first(Int.self, "voiceOptOuts", "voice_opt_outs") ?? 0
        converted = values.first(Int.self, "converted", "conversions") ?? 0
        recoveredOrders = values.first(Int.self, "recoveredOrders", "recovered_orders") ?? converted
        recoveredRevenue = values.first(FlexibleDecimal.self, "recoveredRevenue", "recovered_revenue")
        currency = values.first(String.self, "currency") ?? "USD"
        topReasons = values.first([CartRecoveryReasonMetric].self, "topReasons", "top_reasons") ?? []
    }
}

struct CartRecoveryReasonMetric: Decodable, Hashable, Identifiable {
    let category: String
    let count: Int
    let recoveryRate: Double?
    let recoveredRevenue: FlexibleDecimal?
    var id: String { category }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        category = values.first(String.self, "category", "reason", "primaryCategory", "primary_category") ?? "UNKNOWN"
        count = values.first(Int.self, "count", "replies") ?? 0
        recoveryRate = values.first(Double.self, "recoveryRate", "recovery_rate")
        recoveredRevenue = values.first(FlexibleDecimal.self, "recoveredRevenue", "recovered_revenue")
    }
}

struct CartRecoveryJourneyPage: Decodable, Hashable {
    let journeys: [CartRecoveryJourney]
    let nextCursor: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        journeys = values.first([CartRecoveryJourney].self, "journeys", "items") ?? []
        nextCursor = values.first(String.self, "nextCursor", "next_cursor")
    }
}

struct CartRecoveryJourneyDetail: Decodable, Hashable {
    let journey: CartRecoveryJourney
    let timeline: [CartRecoveryTimelineEvent]
    let replies: [CartRecoveryReply]
    let voiceAttempt: CartRecoveryVoiceAttempt?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        guard let journey = values.first(CartRecoveryJourney.self, "journey") else {
            throw DecodingError.keyNotFound(CartRecoveryWireKey(stringValue: "journey")!,
                                            .init(codingPath: decoder.codingPath,
                                                  debugDescription: "Missing journey"))
        }
        self.journey = journey
        timeline = values.first([CartRecoveryTimelineEvent].self, "timeline", "events") ?? []
        replies = values.first([CartRecoveryReply].self, "replies") ?? []
        voiceAttempt = values.first(CartRecoveryVoiceAttempt.self, "voiceAttempt", "voice_attempt")
    }
}

struct CartRecoveryVoiceAttempt: Decodable, Hashable, Identifiable {
    let id: String
    let state: String
    let attemptNumber: Int
    let dryRun: Bool
    let provider: String?
    let amdMode: String?
    let amdResult: String?
    let humanAnswerMode: String?
    let voiceID: String?
    let voiceModelID: String?
    let answeredAt: String?
    let firstAudioAt: String?
    let humanAnswerDetectionLatencyMs: Int?
    let humanAnswerFirstAudioLatencyMs: Int?
    let voicemailPlayedAt: String?
    let humanMessagePlayedAt: String?
    let transferRequestedAt: String?
    let transferConnectedAt: String?
    let optOutAt: String?
    let optOutMethod: String?
    let failureCode: String?
    let initiatedAt: String?
    let completedAt: String?
}

struct CartRecoveryProduct: Decodable, Hashable, Identifiable {
    let productID: String?
    let variationID: String?
    let name: String
    let quantity: Int
    let permalink: String?
    var id: String { [productID, variationID, name].compactMap { $0 }.joined(separator: ":") }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        productID = values.first(String.self, "productId", "product_id")
            ?? values.first(Int.self, "productId", "product_id").map(String.init)
        variationID = values.first(String.self, "variationId", "variation_id")
            ?? values.first(Int.self, "variationId", "variation_id").map(String.init)
        name = values.first(String.self, "name", "productName", "product_name") ?? "Product"
        quantity = values.first(Int.self, "quantity") ?? 1
        permalink = values.first(String.self, "permalink", "url", "productUrl", "product_url")
    }
}

struct CartRecoveryJourney: Decodable, Hashable, Identifiable {
    let id: String
    let status: String
    let customerName: String?
    let firstName: String?
    let phone: String?
    let phoneAvailable: Bool
    let smsConsent: Bool
    let pushPermission: Bool
    let identityResolutionAmbiguous: Bool
    let products: [CartRecoveryProduct]
    let cartValue: FlexibleDecimal?
    let currency: String
    let lastActivityAt: String?
    let primaryProduct: String?
    let recoveryURL: String?
    let smsQueuedAt: String?
    let smsContent: String?
    let smsStatus: String?
    let pushQueuedAt: String?
    let pushContent: String?
    let pushDestination: String?
    let pushStatus: String?
    let pushBlockedReason: String?
    let voiceConsent: Bool
    let voiceQueuedAt: String?
    let voiceStatus: String?
    let voiceAttemptCount: Int
    let voiceBlockedReason: String?
    let voiceTransferConnectedAt: String?
    let replyStatus: String?
    let category: String
    let secondaryCategory: String?
    let classificationConfidence: Double?
    let aiSummary: String?
    let aiDraftStatus: String?
    let purchaseStatus: String?
    let orderID: String?
    let recoveredRevenue: FlexibleDecimal?
    let grossRecoveredRevenue: FlexibleDecimal?
    let refundAmount: FlexibleDecimal?
    let attributionMethod: String?
    let attributionStrength: String?
    let orderPaidAt: String?
    let createdAt: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        id = values.first(String.self, "id") ?? values.first(Int.self, "id").map(String.init) ?? ""
        status = values.first(String.self, "status", "journeyStatus", "journey_status") ?? "UNKNOWN"
        customerName = values.first(String.self, "customerName", "customer_name", "name")
        firstName = values.first(String.self, "firstName", "first_name")
        phone = values.first(String.self, "phone", "customerPhone", "customer_phone")
        phoneAvailable = values.first(Bool.self, "phoneAvailable", "phone_available") ?? !(phone ?? "").isEmpty
        smsConsent = values.first(Bool.self, "smsConsent", "sms_consent", "consentGranted", "consent_granted") ?? false
        pushPermission = values.first(Bool.self, "pushPermission", "push_permission", "customerPushPermission", "customer_push_permission") ?? false
        identityResolutionAmbiguous = values.first(Bool.self, "identityResolutionAmbiguous", "identity_resolution_ambiguous") ?? false
        products = values.first([CartRecoveryProduct].self, "products", "items", "cartItems", "cart_items") ?? []
        cartValue = values.first(FlexibleDecimal.self, "cartValue", "cart_value", "total")
        currency = values.first(String.self, "currency") ?? "USD"
        lastActivityAt = values.first(String.self, "lastActivityAt", "last_activity_at", "lastActivity")
        primaryProduct = values.first(String.self, "primaryProduct", "primary_product", "productName", "product_name")
        recoveryURL = values.first(String.self, "recoveryUrl", "recoveryURL", "recovery_url")
        smsQueuedAt = values.first(String.self, "smsQueuedAt", "sms_queued_at", "dueAt", "due_at")
        smsContent = values.first(String.self, "smsContent", "sms_content", "message", "messageBody", "message_body")
        smsStatus = values.first(String.self, "smsStatus", "sms_status")
        pushQueuedAt = values.first(String.self, "pushQueuedAt", "push_queued_at", "pushDueAt", "push_due_at")
        pushContent = values.first(String.self, "pushContent", "push_content", "pushBody", "push_body")
        pushDestination = values.first(String.self, "pushDestination", "push_destination")
        pushStatus = values.first(String.self, "pushStatus", "push_status")
        pushBlockedReason = values.first(String.self, "pushBlockedReason", "push_blocked_reason")
        voiceConsent = values.first(Bool.self, "voiceConsent", "voice_consent") ?? false
        voiceQueuedAt = values.first(String.self, "voiceQueuedAt", "voice_queued_at", "voiceDueAt", "voice_due_at")
        voiceStatus = values.first(String.self, "voiceStatus", "voice_status")
        voiceAttemptCount = values.first(Int.self, "voiceAttemptCount", "voice_attempt_count") ?? 0
        voiceBlockedReason = values.first(String.self, "voiceBlockedReason", "voice_blocked_reason")
        voiceTransferConnectedAt = values.first(String.self, "voiceTransferConnectedAt", "voice_transfer_connected_at")
        replyStatus = values.first(String.self, "replyStatus", "reply_status")
        category = values.first(String.self, "category", "primaryCategory", "primary_category") ?? "UNKNOWN"
        secondaryCategory = values.first(String.self, "secondaryCategory", "secondary_category")
        classificationConfidence = values.first(Double.self, "classificationConfidence", "classification_confidence", "confidence")
        aiSummary = values.first(String.self, "aiSummary", "ai_summary", "summary")
        aiDraftStatus = values.first(String.self, "aiDraftStatus", "ai_draft_status")
        purchaseStatus = values.first(String.self, "purchaseStatus", "purchase_status")
        orderID = values.first(String.self, "orderId", "orderID", "order_id")
            ?? values.first(Int.self, "orderId", "orderID", "order_id").map(String.init)
        recoveredRevenue = values.first(FlexibleDecimal.self, "recoveredRevenue", "recovered_revenue")
        grossRecoveredRevenue = values.first(FlexibleDecimal.self, "grossRecoveredRevenue", "gross_recovered_revenue")
        refundAmount = values.first(FlexibleDecimal.self, "refundAmount", "refund_amount")
        attributionMethod = values.first(String.self, "attributionMethod", "attribution_method")
        attributionStrength = values.first(String.self, "attributionStrength", "attribution_strength")
        orderPaidAt = values.first(String.self, "orderPaidAt", "order_paid_at")
        createdAt = values.first(String.self, "createdAt", "created_at")
    }

    var displayName: String {
        if let customerName, !customerName.isEmpty { return customerName }
        if let firstName, !firstName.isEmpty { return firstName }
        if let phone, !phone.isEmpty { return PhoneFormatter.pretty(phone) }
        return "Customer"
    }

    var itemCount: Int { products.reduce(0) { $0 + max(1, $1.quantity) } }
}

struct CartRecoveryTimelineEvent: Decodable, Hashable, Identifiable {
    let id: String
    let type: String
    let title: String
    let detail: String?
    let orderID: String?
    let attributionMethod: String?
    let attributionStrength: String?
    let netRevenue: FlexibleDecimal?
    let refundAmount: FlexibleDecimal?
    let currency: String?
    let createdAt: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        id = values.first(String.self, "id") ?? UUID().uuidString
        type = values.first(String.self, "type", "eventType", "event_type") ?? "event"
        title = values.first(String.self, "title", "label")
            ?? type.replacingOccurrences(of: "_", with: " ").capitalized
        detail = values.first(String.self, "detail", "description", "message")
        orderID = values.first(String.self, "orderId", "orderID", "order_id")
            ?? values.first(Int.self, "orderId", "orderID", "order_id").map(String.init)
        attributionMethod = values.first(String.self, "attributionMethod", "attribution_method")
        attributionStrength = values.first(String.self, "attributionStrength", "attribution_strength")
        netRevenue = values.first(FlexibleDecimal.self, "netRevenue", "net_revenue")
        refundAmount = values.first(FlexibleDecimal.self, "refundAmount", "refund_amount")
        currency = values.first(String.self, "currency")
        createdAt = values.first(String.self, "createdAt", "created_at", "occurredAt", "occurred_at")
    }
}

struct CartRecoveryReply: Decodable, Hashable, Identifiable {
    let id: String
    let customerMessage: String?
    let category: String
    let secondaryCategory: String?
    let confidence: Double?
    let summary: String?
    let draft: String?
    let draftStatus: String
    let medicalEscalation: Bool
    let receivedAt: String?
    let sentAt: String?

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        id = values.first(String.self, "id") ?? values.first(Int.self, "id").map(String.init) ?? ""
        customerMessage = values.first(String.self, "customerMessage", "customer_message", "message", "body")
        category = values.first(String.self, "category", "primaryCategory", "primary_category") ?? "UNKNOWN"
        secondaryCategory = values.first(String.self, "secondaryCategory", "secondary_category")
        confidence = values.first(Double.self, "confidence", "confidenceScore", "confidence_score")
        summary = values.first(String.self, "summary", "aiSummary", "ai_summary")
        draft = values.first(String.self, "draft", "draftReply", "draft_reply")
        draftStatus = values.first(String.self, "draftStatus", "draft_status", "status") ?? "NONE"
        medicalEscalation = values.first(Bool.self, "medicalEscalation", "medical_escalation", "requiresMedicalReview") ?? false
        receivedAt = values.first(String.self, "receivedAt", "received_at", "createdAt", "created_at")
        sentAt = values.first(String.self, "sentAt", "sent_at")
    }
}

struct CartRecoveryReplyEnvelope: Decodable {
    let reply: CartRecoveryReply
}

struct CartRecoveryReplyActionResponse: Decodable {
    let reply: CartRecoveryReply
    let dryRun: Bool
    let sent: Bool

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        guard let reply = values.first(CartRecoveryReply.self, "reply") else {
            throw DecodingError.keyNotFound(CartRecoveryWireKey(stringValue: "reply")!,
                                            .init(codingPath: decoder.codingPath,
                                                  debugDescription: "Missing reply"))
        }
        self.reply = reply
        dryRun = values.first(Bool.self, "dryRun", "dry_run") ?? false
        sent = values.first(Bool.self, "sent") ?? false
    }
}

struct CartRecoverySettingsEnvelope: Decodable {
    let settings: CartRecoverySettings
}

struct RecoveryVoiceOption: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let accent: String?
    let gender: String?
    let age: String?
    let descriptive: String?
    let category: String?
    let previewUrl: String?
    let verified: Bool

    var subtitle: String {
        [accent, gender, descriptive].compactMap { value in
            guard let value, !value.isEmpty else { return nil }
            return value.capitalized
        }.joined(separator: " · ")
    }
}

struct RecoveryVoiceCatalogue: Decodable {
    let voices: [RecoveryVoiceOption]
    let authorizationBoundary: String?
}

struct CartRecoverySettings: Decodable, Hashable {
    var enabled: Bool
    var firstSmsDelayMinutes: Int
    var firstSmsTemplate: String
    var pushEnabled: Bool
    var pushDelayHours: Int
    var pushTitle: String
    var pushBody: String
    var discountPercent: Int
    var discountCode: String
    var singleProductDestination: String
    var multiProductDestination: String
    var lowStockMessagingEnabled: Bool
    var lowStockThreshold: Int
    var attributionWindowDays: Int
    var pushShopAttributionWindowHours: Int
    var aiClassificationEnabled: Bool
    var aiDraftRepliesEnabled: Bool
    let automaticAiSending: Bool
    var voiceEnabled: Bool
    var voiceDelayMinutes: Int
    var voiceAmdMode: String
    var voiceHumanAnswerMode: String
    var voiceID: String?
    var voiceName: String?
    var voiceModelID: String
    var voiceHumanTemplate: String
    var voiceVoicemailTemplate: String
    var voiceCallingWindowStart: String
    var voiceCallingWindowEnd: String
    var voiceDefaultTimezone: String
    var voiceTransferNumber: String?
    var voiceOptOutTollFreeNumber: String?
    let voiceHumanTimingApproved: Bool
    let voiceComplianceApproved: Bool
    let voiceConfigurationReady: Bool
    let voiceProductionReady: Bool
    let voiceBlockers: [String]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CartRecoveryWireKey.self)
        enabled = values.first(Bool.self, "enabled") ?? false
        firstSmsDelayMinutes = values.first(Int.self, "firstSmsDelayMinutes", "first_sms_delay_minutes", "smsDelayMinutes") ?? 45
        firstSmsTemplate = values.first(String.self, "firstSmsTemplate", "first_sms_template", "smsTemplate") ?? ""
        pushEnabled = values.first(Bool.self, "pushEnabled", "push_enabled") ?? false
        pushDelayHours = values.first(Int.self, "pushDelayHours", "push_delay_hours") ?? 48
        pushTitle = values.first(String.self, "pushTitle", "push_title") ?? "Still thinking it over?"
        pushBody = values.first(String.self, "pushBody", "push_body") ?? "Use VICI15 for 15% off."
        discountPercent = values.first(Int.self, "discountPercent", "discount_percent") ?? 15
        discountCode = values.first(String.self, "discountCode", "discount_code") ?? "VICI15"
        singleProductDestination = values.first(String.self, "singleProductDestination", "single_product_destination") ?? "product"
        multiProductDestination = values.first(String.self, "multiProductDestination", "multi_product_destination") ?? "shop"
        lowStockMessagingEnabled = values.first(Bool.self, "lowStockMessagingEnabled", "low_stock_messaging_enabled") ?? false
        lowStockThreshold = values.first(Int.self, "lowStockThreshold", "low_stock_threshold") ?? 5
        attributionWindowDays = values.first(Int.self, "attributionWindowDays", "attribution_window_days") ?? 7
        pushShopAttributionWindowHours = values.first(Int.self, "pushShopAttributionWindowHours", "push_shop_attribution_window_hours") ?? 24
        aiClassificationEnabled = values.first(Bool.self, "aiClassificationEnabled", "ai_classification_enabled") ?? true
        aiDraftRepliesEnabled = values.first(Bool.self, "aiDraftRepliesEnabled", "ai_draft_replies_enabled") ?? true
        automaticAiSending = values.first(Bool.self, "automaticAiSending", "automatic_ai_sending") ?? false
        voiceEnabled = values.first(Bool.self, "voiceEnabled", "voice_enabled") ?? false
        voiceDelayMinutes = values.first(Int.self, "voiceDelayMinutes", "voice_delay_minutes") ?? 180
        voiceAmdMode = values.first(String.self, "voiceAmdMode", "voice_amd_mode") ?? "premium_ios_call_screening_detection"
        voiceHumanAnswerMode = values.first(String.self, "voiceHumanAnswerMode", "voice_human_answer_mode") ?? "DISABLED"
        voiceID = values.first(String.self, "voiceId", "voiceID", "voice_id")
        voiceName = values.first(String.self, "voiceName", "voice_name")
        voiceModelID = values.first(String.self, "voiceModelId", "voiceModelID", "voice_model_id") ?? "eleven_turbo_v2_5"
        voiceHumanTemplate = values.first(String.self, "voiceHumanTemplate", "voice_human_template") ?? ""
        voiceVoicemailTemplate = values.first(String.self, "voiceVoicemailTemplate", "voice_voicemail_template") ?? ""
        voiceCallingWindowStart = values.first(String.self, "voiceCallingWindowStart", "voice_calling_window_start") ?? "09:00"
        voiceCallingWindowEnd = values.first(String.self, "voiceCallingWindowEnd", "voice_calling_window_end") ?? "20:00"
        voiceDefaultTimezone = values.first(String.self, "voiceDefaultTimezone", "voice_default_timezone") ?? "America/New_York"
        voiceTransferNumber = values.first(String.self, "voiceTransferNumber", "voice_transfer_number")
        voiceOptOutTollFreeNumber = values.first(String.self, "voiceOptOutTollFreeNumber", "voice_opt_out_toll_free_number")
        voiceHumanTimingApproved = values.first(Bool.self, "voiceHumanTimingApproved", "voice_human_timing_approved") ?? false
        voiceComplianceApproved = values.first(Bool.self, "voiceComplianceApproved", "voice_compliance_approved") ?? false
        voiceConfigurationReady = values.first(Bool.self, "voiceConfigurationReady", "voice_configuration_ready") ?? false
        voiceProductionReady = values.first(Bool.self, "voiceProductionReady", "voice_production_ready") ?? false
        voiceBlockers = values.first([String].self, "voiceBlockers", "voice_blockers") ?? []
    }

    var requestBody: [String: Any] {
        [
            "enabled": enabled,
            "firstSmsDelayMinutes": firstSmsDelayMinutes,
            "firstSmsTemplate": firstSmsTemplate,
            "pushEnabled": pushEnabled,
            "pushDelayHours": pushDelayHours,
            "pushTitle": pushTitle,
            "pushBody": pushBody,
            "discountPercent": discountPercent,
            "discountCode": discountCode,
            "singleProductDestination": singleProductDestination,
            "multiProductDestination": multiProductDestination,
            "lowStockMessagingEnabled": lowStockMessagingEnabled,
            "lowStockThreshold": lowStockThreshold,
            "attributionWindowDays": attributionWindowDays,
            "pushShopAttributionWindowHours": pushShopAttributionWindowHours,
            "aiClassificationEnabled": aiClassificationEnabled,
            "aiDraftRepliesEnabled": aiDraftRepliesEnabled,
            "voiceEnabled": voiceEnabled,
            "voiceDelayMinutes": voiceDelayMinutes,
            "voiceAmdMode": voiceAmdMode,
            "voiceHumanAnswerMode": voiceHumanAnswerMode,
            "voiceId": voiceID ?? "",
            "voiceModelId": voiceModelID,
            "voiceHumanTemplate": voiceHumanTemplate,
            "voiceVoicemailTemplate": voiceVoicemailTemplate,
            "voiceCallingWindowStart": voiceCallingWindowStart,
            "voiceCallingWindowEnd": voiceCallingWindowEnd,
            "voiceDefaultTimezone": voiceDefaultTimezone,
            "voiceTransferNumber": voiceTransferNumber ?? "",
            "voiceOptOutTollFreeNumber": voiceOptOutTollFreeNumber ?? "",
            // Included explicitly so a future backend cannot mistake omission
            // for permission to enable autonomous AI messages.
            "automaticAiSending": false
        ]
    }
}

struct CallLogRecord: Codable, Identifiable, Hashable {
    let recordID: FlexibleID
    let direction: String?
    let contactPhone: String?
    let durationSeconds: Int?
    let status: String?
    let startedAt: String?
    let recordingURL: String?
    /// Whether audio exists for this call. The server reports this true even
    /// before the recording has been copied into private storage, because it
    /// archives on demand when playback is first requested.
    let recordingAvailable: Bool?
    let contactName: String?
    /// Set once anyone has opened call history. Nil on a schema that has not had
    /// scripts/missed-calls-seen-migration.sql applied, which is why the app
    /// also keeps its own record of what it has shown — see CallHistoryModel.
    let seenAt: String?

    var id: String { recordID.rawValue }

    /// What the badge counts: a call that came in and was not picked up. The
    /// outbound leg to sip:USERNAME is an implementation detail and the backend
    /// already filters it out of history.
    var isMissedInbound: Bool { direction == "inbound" && status == "missed" }

    /// A call worth offering a player for. `recordingAvailable` is absent on an
    /// older server, so fall back to the presence of a playback URL.
    var hasRecording: Bool { recordingAvailable ?? (recordingURL != nil) }

    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case direction
        case contactPhone = "contact_phone"
        case durationSeconds = "duration_seconds"
        case status
        case startedAt = "started_at"
        case recordingURL = "recording_url"
        case recordingAvailable = "recording_available"
        case contactName = "contact_name"
        case seenAt = "seen_at"
    }
}

/**
 * How a message timestamp reads in a thread: "7:04 PM · Sep 8".
 *
 * Kept beside ServerDate because it is the other half of the same job — that
 * one turns the server's string into a Date, this one turns a Date into what
 * the bubble shows. Both apps and the web inbox print the same shape, so a
 * screenshot from one is legible next to a screenshot from the other.
 *
 * The bubble used to show `style: .time`, which is "7:04 PM" and nothing else.
 * That is unambiguous while you are looking at it and useless in a screenshot
 * read days later: you cannot tell a reply that came back in four minutes from
 * one that came the following afternoon.
 *
 * The year appears only when the message is not from the current year, which
 * keeps a normal thread uncluttered without making an old one ambiguous.
 *
 * The formatters are static because DateFormatter construction is expensive and
 * a thread builds one bubble per message while scrolling.
 */
enum MessageStamp {
    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("j:mm")
        return formatter
    }()
    private static let dayMonth: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d")
        return formatter
    }()
    private static let dayMonthYear: DateFormatter = {
        let formatter = DateFormatter()
        formatter.setLocalizedDateFormatFromTemplate("MMM d yyyy")
        return formatter
    }()

    /// - Parameter timeZone: the app's effective zone, so a bubble agrees with
    ///   Settings, the appearance schedule and the web inbox rather than
    ///   silently reading the device clock.
    static func format(_ date: Date, timeZone: TimeZone, now: Date = Date()) -> String {
        var calendar = Calendar.current
        calendar.timeZone = timeZone
        // The year test has to run in the SAME zone the date is printed in, or
        // a message just either side of New Year gains or loses a year label.
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)

        time.timeZone = timeZone
        let dayFormatter = sameYear ? dayMonth : dayMonthYear
        dayFormatter.timeZone = timeZone
        return "\(time.string(from: date)) · \(dayFormatter.string(from: date))"
    }
}

enum ServerDate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let standard = ISO8601DateFormatter()

    static func parse(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractional.date(from: value) ?? standard.date(from: value)
    }
}
