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

struct ContactPage: Codable { let contacts: [ConversationSummary]; let page: Int; let hasMore: Bool }

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

struct CallLogRecord: Codable, Identifiable, Hashable {
    let recordID: FlexibleID
    let direction: String?
    let contactPhone: String?
    let durationSeconds: Int?
    let status: String?
    let startedAt: String?
    let recordingURL: String?

    var id: String { recordID.rawValue }
    enum CodingKeys: String, CodingKey {
        case recordID = "id"
        case direction
        case contactPhone = "contact_phone"
        case durationSeconds = "duration_seconds"
        case status
        case startedAt = "started_at"
        case recordingURL = "recording_url"
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
