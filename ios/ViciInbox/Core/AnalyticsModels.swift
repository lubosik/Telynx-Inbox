import Foundation

enum AnalyticsPeriod: String, CaseIterable, Identifiable, Codable {
    case today
    case week
    case month
    case year
    case all
    case custom

    var id: String { rawValue }

    var title: String {
        switch self {
        case .today: return "Today"
        case .week: return "Week"
        case .month: return "Month"
        case .year: return "Year"
        case .all: return "All Time"
        case .custom: return "Custom"
        }
    }
}

struct AnalyticsDateRange: Codable, Hashable {
    let period: String
    let start: String
    let end: String
    let timeZone: String
    let previous: AnalyticsComparisonRange?
}

struct AnalyticsComparisonRange: Codable, Hashable {
    let start: String
    let end: String
}

struct AnalyticsWarning: Codable, Hashable, Identifiable {
    let code: String
    let message: String
    var id: String { code + message }
}

struct AnalyticsAvailability: Codable, Hashable {
    let revenueAttribution: Bool
    let paymentRecovery: Bool
    let messaging: Bool
    let responsePerformance: Bool
    let calls: Bool
    let sentiment: Bool
    let historicalBackfill: Bool
}

struct RevenueConfidenceBreakdown: Codable, Hashable {
    let label: String
    let confidenceScore: FlexibleDecimal
    let netRevenue: FlexibleDecimal
    let orderCount: Int
}

struct RevenueBreakdown: Codable, Hashable {
    let direct: RevenueConfidenceBreakdown
    let strong: RevenueConfidenceBreakdown
    let influenced: RevenueConfidenceBreakdown
    let unattributed: RevenueConfidenceBreakdown
}

struct AnalyticsRevenue: Codable, Hashable {
    let recoveredRevenue: FlexibleDecimal
    let attributedRevenue: FlexibleDecimal
    let influencedRevenue: FlexibleDecimal
    let totalRevenueImpact: FlexibleDecimal
    let weightedAttributedValue: FlexibleDecimal
    let unattributedRevenue: FlexibleDecimal
    let grossAttributedRevenue: FlexibleDecimal
    let refundedAttributedRevenue: FlexibleDecimal
    let breakdown: RevenueBreakdown
}

struct AnalyticsRevenueDriver: Codable, Hashable, Identifiable {
    let key: String
    let label: String
    let attributedRevenue: FlexibleDecimal
    let influencedRevenue: FlexibleDecimal
    let totalRevenueImpact: FlexibleDecimal
    let grossRevenue: FlexibleDecimal
    let refundedRevenue: FlexibleDecimal
    let attributedOrders: Int
    let influencedOrders: Int
    let breakdown: RevenueBreakdown
    var id: String { key }

    var hasMeasuredValue: Bool {
        attributedRevenue.value != 0 || influencedRevenue.value != 0 ||
            totalRevenueImpact.value != 0 || attributedOrders > 0 || influencedOrders > 0
    }
}

struct PaymentRecoveryMetrics: Codable, Hashable {
    let cohort: String
    let remindersSent: Int
    let remindersDelivered: Int
    let uniqueCustomersReminded: Int
    let ordersRecovered: Int
    let recoveredRevenue: FlexibleDecimal
    let recoveryRate: Double?
    let medianRecoverySeconds: Double?
    let directRecoveries: Int
    let strongRecoveries: Int
}

struct AnalyticsEvent: Decodable, Hashable {
    let type: String
}

struct MessagingMetrics: Codable, Hashable {
    let outbound: Int
    let inbound: Int
    let total: Int
    let conversations: Int
    let uniqueCustomersContacted: Int
    let repliesReceived: Int
    let replyRate: Double?
    let delivered: Int
    let sent: Int
    let queued: Int
    let failed: Int
    let optOuts: Int
}

struct ResponsePerformanceMetrics: Codable, Hashable {
    let medianFirstResponseSeconds: Double?
    let averageFirstResponseSeconds: Double?
    let under5MinutesPercent: Double?
    let under15MinutesPercent: Double?
    let answeredConversations: Int
    let unansweredConversations: Int
}

struct CallAnalyticsMetrics: Codable, Hashable {
    let total: Int
    let inbound: Int
    let outbound: Int
    let answered: Int
    let missed: Int
    let completed: Int
    let totalTalkSeconds: Double
    let averageDurationSeconds: Double?
    let uniqueCustomers: Int
    let answerRate: Double?
}

struct SentimentMetrics: Codable, Hashable {
    let label: String?
    let averageScore: Double?
    let changeFromPrevious: Double?
    let positivePercentage: Double?
    let neutralPercentage: Double?
    let negativePercentage: Double?
    let messagesAnalyzed: Int
    let coveragePercentage: Double?
}

struct AnalyticsTrends: Codable, Hashable {
    let attributedRevenuePercent: Double?
    let recoveredRevenuePercent: Double?
    let messagesOutboundPercent: Double?
    let medianResponseSecondsPercent: Double?
    let completedCallsPercent: Double?
    let sentimentScoreChange: Double?
}

struct AnalyticsActivityPoint: Codable, Hashable, Identifiable {
    let date: String
    /// Additive ISO-8601 bucket boundary from newer servers. `date` remains
    /// the fallback so this app can roll out before or after the backend.
    let bucketStart: String?
    let outboundMessages: Int
    let inboundMessages: Int
    let completedCalls: Int
    let recoveredRevenue: FlexibleDecimal
    let influencedRevenue: FlexibleDecimal
    let sentimentAverage: Double?
    var id: String { date }
}

struct AnalyticsOverview: Codable, Hashable {
    let generatedAt: String
    let version: Int
    let currency: String
    let range: AnalyticsDateRange
    let revenue: AnalyticsRevenue
    /// Added after the first Analytics release. Optional keeps the iOS rollout
    /// compatible with an older backend while never fabricating categories.
    let revenueDrivers: [AnalyticsRevenueDriver]?
    let paymentRecovery: PaymentRecoveryMetrics
    let messaging: MessagingMetrics
    let responsePerformance: ResponsePerformanceMetrics
    let calls: CallAnalyticsMetrics
    let sentiment: SentimentMetrics
    let trends: AnalyticsTrends
    let activitySeries: [AnalyticsActivityPoint]
    /// hour, day, week or month on newer servers. Nil means the legacy daily
    /// series and is handled conservatively by the chart.
    let activityGranularity: String?
    let availability: AnalyticsAvailability
    let warnings: [AnalyticsWarning]
}

enum AttributionConfidence: String, Codable, Hashable {
    case direct
    case strong
    case influenced
    case unattributed

    var title: String {
        switch self {
        case .direct: return "100% Direct"
        case .strong: return "90% Strong"
        case .influenced: return "60% Influenced"
        case .unattributed: return "Unattributed"
        }
    }
}

enum AttributionScope: String, CaseIterable, Identifiable {
    case attributed
    case influenced
    case unattributed

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct AttributionRecord: Codable, Hashable, Identifiable {
    let id: String
    let orderId: String
    let customerId: String?
    let category: String?
    let workflow: String?
    let grossAmount: FlexibleDecimal
    let refundedAmount: FlexibleDecimal
    let netAmount: FlexibleDecimal
    let confidenceLevel: AttributionConfidence
    let confidenceScore: FlexibleDecimal
    let confidenceLabel: String
    let originatingActionType: String?
    let originatingActionId: String?
    let actionAt: String?
    let conversionAt: String?
    let attributionWindowSeconds: Int?
    let reason: String
    let supportingEvidence: [String]
    let isRefunded: Bool
    let invalidatedAt: String?

    /// Defence in depth for devices talking to an older backend. The UI never
    /// renders the free-text `reason` field; explanations are produced only
    /// from the fixed classification and allowlisted evidence-code DTO.
    var safeExplanation: String {
        let evidence = Set(supportingEvidence)
        if invalidatedAt != nil {
            return "Later authoritative evidence invalidated this attribution, so it is excluded from active totals."
        }
        switch confidenceLevel {
        case .direct:
            if evidence.contains("payment_confirmation") && evidence.contains("authoritative_payment") {
                return "An app interaction and authoritative payment confirmation directly link this order."
            }
            if evidence.contains("trusted_provider_delivery") && evidence.contains("exact_target_product") {
                return "Trusted campaign delivery and an exact matching product conversion directly link this order."
            }
            return "Structured communication and order evidence directly link this conversion to the app."
        case .strong:
            return "The exact customer or order match and conversion timing strongly link this revenue to the app."
        case .influenced:
            return "The app interaction occurred before the purchase, but the available evidence cannot prove it caused the order."
        case .unattributed:
            if evidence.contains("outside_attribution_window") {
                return "The order occurred outside the approved attribution window and remains Unattributed."
            }
            if evidence.contains("target_product_not_in_order") || evidence.contains("target_product_evidence_missing") {
                return "The available product evidence does not match the campaign closely enough to attribute this order."
            }
            if evidence.contains("recipient_identity_not_exact") || evidence.contains("customer_id_conflict") ||
                evidence.contains("contradictory_evidence") {
                return "Customer or order evidence is incomplete or contradictory, so this revenue remains Unattributed."
            }
            return "There is not enough verified evidence to fairly attribute this order to the app."
        }
    }
}

struct AnalyticsPagination: Codable, Hashable {
    let page: Int
    let pageSize: Int
    let total: Int
    let hasMore: Bool
}

struct AttributionPage: Codable, Hashable {
    let generatedAt: String
    let currency: String
    let scope: String
    let range: AnalyticsDateRange
    let items: [AttributionRecord]
    let pagination: AnalyticsPagination
    let warnings: [AnalyticsWarning]
}

struct AnalyticsQuery: Hashable {
    let period: AnalyticsPeriod
    let start: Date?
    let end: Date?

    static let initial = AnalyticsQuery(period: .month, start: nil, end: nil)

    var queryItems: [URLQueryItem] {
        var items = [URLQueryItem(name: "period", value: period.rawValue)]
        if period == .custom, let start, let end {
            items.append(URLQueryItem(name: "start", value: Self.dayFormatter.string(from: start)))
            items.append(URLQueryItem(name: "end", value: Self.dayFormatter.string(from: end)))
        }
        return items
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        // Preserve the calendar day chosen in DatePicker. The server applies
        // the account timezone when it expands this date into an instant.
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
