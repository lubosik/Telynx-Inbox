import SwiftUI
import Charts

struct AnalyticsView: View {
    let isSelected: Bool
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AnalyticsViewModel()
    @State private var showingCustomRange = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    AnalyticsPeriodPicker(selected: model.period) { period in
                        if period == .custom {
                            showingCustomRange = true
                        } else {
                            model.period = period
                            Task { await model.load() }
                        }
                    }

                    content
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Analytics")
            .accountToolbar()
            .refreshable { await model.load(force: true) }
            .task(id: isSelected) {
                guard isSelected else { return }
                await model.load()
                await model.listenForChanges()
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active && isSelected { Task { await model.load(force: true) } }
            }
            .sheet(isPresented: $showingCustomRange) {
                AnalyticsDateRangeSheet(start: model.customStart, end: model.customEnd) { start, end in
                    Task { await model.applyCustomRange(start: start, end: end) }
                }
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.isLoading && model.overview == nil {
            VStack(spacing: 12) {
                ProgressView().controlSize(.large)
                Text("Calculating verified impact…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 360)
        } else if let overview = model.overview {
            overviewContent(overview)
        } else {
            AnalyticsUnavailableView(message: model.errorMessage) {
                Task { await model.load(force: true) }
            }
            .frame(minHeight: 360)
        }
    }

    @ViewBuilder
    private func overviewContent(_ overview: AnalyticsOverview) -> some View {
        AnalyticsFreshnessView(overview: overview, isRefreshing: model.isRefreshing)

        ForEach(overview.warnings) { warning in
            Label(warning.message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(ViciTheme.warning.opacity(0.13), in: RoundedRectangle(cornerRadius: 14))
                .accessibilityLabel("Analytics notice: \(warning.message)")
        }

        if let message = model.errorMessage {
            Label("Showing the last available result. Refresh failed: \(message)",
                  systemImage: "wifi.exclamationmark")
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(ViciTheme.destructive.opacity(0.1), in: RoundedRectangle(cornerRadius: 14))
        }

        if overview.availability.revenueAttribution {
            // The tour's attribution step describes this card. It is only a
            // candidate: the resolver drops it when it is taller than the
            // screen or scrolled away, and falls back to the Analytics tab.
            RevenueImpactCard(overview: overview, query: model.query)
                .onboardingTarget(.revenueAttribution)
            let measuredDrivers = (overview.revenueDrivers ?? []).filter(\.hasMeasuredValue)
            if !measuredDrivers.isEmpty {
                RevenueDriversCard(drivers: measuredDrivers, currency: overview.currency)
            }
        } else {
            AnalyticsCard(emphasized: true) {
                VStack(alignment: .leading, spacing: 10) {
                    Label("Revenue history pending", systemImage: "clock.badge.exclamationmark")
                        .font(.headline)
                    Text("Verified historical orders have not been promoted yet. Revenue totals stay hidden until the audit-safe backfill is complete.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }

        if overview.availability.paymentRecovery {
            NavigationLink {
                AttributionListView(query: model.query,
                                    initialScope: .attributed,
                                    category: "payment_recovery")
            } label: {
                PaymentRecoveryCard(metrics: overview.paymentRecovery, currency: overview.currency)
            }
            .buttonStyle(.plain)
        }

        if overview.availability.sentiment {
            SentimentCard(metrics: overview.sentiment)
        }

        if overview.availability.responsePerformance {
            ResponsePerformanceCard(metrics: overview.responsePerformance,
                                    trend: overview.trends.medianResponseSecondsPercent)
        }

        if overview.availability.messaging {
            MessagingCard(metrics: overview.messaging,
                          series: overview.activitySeries,
                          trend: overview.trends.messagesOutboundPercent,
                          granularity: overview.activityGranularity,
                          timeZoneIdentifier: overview.range.timeZone)
        }

        if overview.availability.calls {
            CallsAnalyticsCard(metrics: overview.calls,
                               trend: overview.trends.completedCallsPercent)
        }

        if !overview.availability.revenueAttribution &&
            !overview.availability.messaging &&
            !overview.availability.calls {
            AnalyticsCard {
                EmptyState(icon: "chart.bar.xaxis",
                           title: "No analytics data yet",
                           detail: "Activity will appear here once verified data is available for this period.")
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

private struct RevenueDriversCard: View {
    let drivers: [AnalyticsRevenueDriver]
    let currency: String

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Revenue Drivers", symbol: "point.3.connected.trianglepath.dotted")
            ForEach(Array(drivers.enumerated()), id: \.element.id) { index, driver in
                if index > 0 { Divider() }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(driver.label).font(.subheadline.weight(.semibold))
                        Spacer()
                        Text(AnalyticsFormatting.money(driver.attributedRevenue, currency: currency))
                            .font(.headline.monospacedDigit())
                    }
                    Text("\(driver.attributedOrders.formatted()) attributed order\(driver.attributedOrders == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if driver.influencedRevenue.value != 0 || driver.influencedOrders > 0 {
                        Text("Influenced: \(AnalyticsFormatting.money(driver.influencedRevenue, currency: currency)) from \(driver.influencedOrders.formatted()) order\(driver.influencedOrders == 1 ? "" : "s")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if driver.refundedRevenue.value != 0 {
                        Text("Refunds deducted: \(AnalyticsFormatting.money(driver.refundedRevenue, currency: currency))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
    }
}

private struct AnalyticsPeriodPicker: View {
    let selected: AnalyticsPeriod
    let select: (AnalyticsPeriod) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AnalyticsPeriod.allCases) { period in
                    Button(period.title) { select(period) }
                        .font(.subheadline.weight(selected == period ? .semibold : .regular))
                        .foregroundStyle(selected == period ? Color.white : Color.primary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(selected == period ? ViciTheme.tealFill : Color(.secondarySystemGroupedBackground),
                                    in: Capsule())
                        .accessibilityAddTraits(selected == period ? .isSelected : [])
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Analytics date range")
    }
}

private struct AnalyticsFreshnessView: View {
    let overview: AnalyticsOverview
    let isRefreshing: Bool

    var body: some View {
        HStack(spacing: 6) {
            if isRefreshing { ProgressView().controlSize(.small) }
            Image(systemName: "clock.arrow.circlepath")
            if let generated = ServerDate.parse(overview.generatedAt) {
                Text("Updated \(generated, style: .relative)")
            } else {
                Text("Latest verified data")
            }
            Text("•")
            Text(rangeLabel)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private var rangeLabel: String {
        guard let start = ServerDate.parse(overview.range.start),
              let rawEnd = ServerDate.parse(overview.range.end),
              let businessTimeZone = TimeZone(identifier: overview.range.timeZone) else {
            return overview.range.timeZone
        }
        // Custom end dates are inclusive in the picker but represented by the
        // server as the next midnight (an exclusive query boundary).
        let end = overview.range.period == AnalyticsPeriod.custom.rawValue
            ? rawEnd.addingTimeInterval(-1)
            : rawEnd
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = businessTimeZone
        var monthDay = Date.FormatStyle.dateTime.month(.abbreviated).day()
        monthDay.timeZone = businessTimeZone
        var monthDayYear = monthDay.year()
        monthDayYear.timeZone = businessTimeZone
        if calendar.isDate(start, inSameDayAs: end) {
            return start.formatted(monthDayYear)
        }
        return "\(start.formatted(monthDay))–\(end.formatted(monthDayYear))"
    }
}

private struct RevenueImpactCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let overview: AnalyticsOverview
    let query: AnalyticsQuery

    var body: some View {
        AnalyticsCard(emphasized: true) {
            VStack(alignment: .leading, spacing: 16) {
                NavigationLink {
                    AttributionListView(query: query, initialScope: .attributed)
                } label: {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(AnalyticsFormatting.money(overview.revenue.attributedRevenue,
                                                           currency: overview.currency))
                                .font(.system(.largeTitle, design: .rounded, weight: .bold))
                                .minimumScaleFactor(0.65)
                                .lineLimit(1)
                            Text("Attributed Revenue")
                                .font(.headline)
                            Text("Revenue linked to app activity with strong evidence")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                }
                .buttonStyle(.plain)

                if let trend = overview.trends.attributedRevenuePercent {
                    AnalyticsTrend(value: trend, suffix: "attributed vs previous")
                }

                Divider()

                LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 10) {
                    RevenueLevel(value: overview.revenue.breakdown.direct.netRevenue,
                                 currency: overview.currency,
                                 title: "100% Direct",
                                 count: overview.revenue.breakdown.direct.orderCount,
                                 color: ViciTheme.success)
                    RevenueLevel(value: overview.revenue.breakdown.strong.netRevenue,
                                 currency: overview.currency,
                                 title: "90% Strong",
                                 count: overview.revenue.breakdown.strong.orderCount,
                                 color: ViciTheme.tint)
                }

                if overview.revenue.breakdown.influenced.orderCount > 0 ||
                    overview.revenue.influencedRevenue.value != 0 {
                    Divider()
                    NavigationLink {
                        AttributionListView(query: query, initialScope: .influenced)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Influenced Revenue")
                                    .font(.subheadline.weight(.semibold))
                                Text("60% influenced, shown separately")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(AnalyticsFormatting.money(overview.revenue.influencedRevenue,
                                                           currency: overview.currency))
                                .font(.headline.monospacedDigit())
                            Image(systemName: "chevron.right")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }

                if overview.revenue.breakdown.unattributed.orderCount > 0 {
                    Divider()
                    NavigationLink {
                        AttributionListView(query: query, initialScope: .unattributed)
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Unattributed, correctly excluded")
                                    .font(.subheadline.weight(.semibold))
                                Text("Reviewed payments without enough evidence")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Text(overview.revenue.breakdown.unattributed.orderCount.formatted())
                                .font(.title3.bold().monospacedDigit())
                            Image(systemName: "chevron.right")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }

                if overview.revenue.refundedAttributedRevenue.value != 0 {
                    Label("Refunds deducted: \(AnalyticsFormatting.money(overview.revenue.refundedAttributedRevenue, currency: overview.currency))",
                          systemImage: "arrow.uturn.backward.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                NavigationLink {
                    AttributionMethodologyView()
                } label: {
                    Label("How attribution works", systemImage: "questionmark.circle")
                        .font(.subheadline.weight(.semibold))
                }
            }
        }
    }
}

private struct AttributionMethodologyView: View {
    var body: some View {
        List {
            Section("Direct") {
                Text("We can clearly connect the app action to the payment.")
            }
            Section("Strong") {
                Text("The timing and order data strongly link the app action to the payment.")
            }
            Section("Influenced") {
                Text("The app likely helped, but we cannot prove it caused the purchase.")
            }
            Section("Unattributed") {
                Text("There is not enough evidence to fairly credit the app. These orders stay out of attributed revenue.")
            }
        }
        .navigationTitle("How Attribution Works")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct RevenueLevel: View {
    let value: FlexibleDecimal
    let currency: String
    let title: String
    let count: Int
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(AnalyticsFormatting.money(value, currency: currency))
                .font(.title3.bold().monospacedDigit())
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(color)
            Text("\(count.formatted()) \(count == 1 ? "order" : "orders")")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PaymentRecoveryCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let metrics: PaymentRecoveryMetrics
    let currency: String

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Payment Recovery", symbol: "creditcard.fill")

            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 16) {
                AnalyticsPrimaryMetric(
                    value: AnalyticsFormatting.money(metrics.recoveredRevenue, currency: currency),
                    label: "Revenue recovered"
                )
                AnalyticsPrimaryMetric(value: metrics.ordersRecovered.formatted(),
                                       label: "Orders recovered")
            }

            Divider()

            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 16) {
                AnalyticsMetric(value: metrics.remindersSent.formatted(), label: "Reminders")
                AnalyticsMetric(value: metrics.remindersDelivered.formatted(), label: "Delivered reminders")
                AnalyticsMetric(value: metrics.uniqueCustomersReminded.formatted(), label: "Customers reminded")
                AnalyticsMetric(value: AnalyticsFormatting.percent(metrics.recoveryRate), label: "Recovery rate")
                AnalyticsMetric(value: AnalyticsFormatting.duration(metrics.medianRecoverySeconds),
                                label: "Median recovery")
                AnalyticsMetric(value: "\(metrics.directRecoveries) / \(metrics.strongRecoveries)",
                                label: "Direct / strong")
            }
        }
    }
}

private struct AnalyticsPrimaryMetric: View {
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.title2.bold().monospacedDigit())
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct SentimentCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let metrics: SentimentMetrics

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Customer Sentiment", symbol: "face.smiling")
            if let score = metrics.averageScore, metrics.messagesAnalyzed > 0 {
                HStack(alignment: .firstTextBaseline) {
                    Text(metrics.label ?? "Measured")
                        .font(.title2.bold())
                    Spacer()
                    if let change = metrics.changeFromPrevious {
                        SentimentChange(value: change)
                    }
                }
                SentimentGauge(score: score)
                LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 10) {
                    SentimentShare(label: "Positive", value: metrics.positivePercentage, color: ViciTheme.success)
                    SentimentShare(label: "Neutral", value: metrics.neutralPercentage, color: .secondary)
                    SentimentShare(label: "Negative", value: metrics.negativePercentage, color: ViciTheme.destructive)
                }
                Text("Based on \(metrics.messagesAnalyzed.formatted()) customer messages • \(AnalyticsFormatting.percent(metrics.coveragePercentage)) coverage")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("Not enough customer messages to calculate sentiment for this period.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct SentimentGauge: View {
    let score: Double

    var body: some View {
        GeometryReader { geometry in
            let clamped = max(-2, min(2, score))
            let fraction = (clamped + 2) / 4
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(LinearGradient(colors: [ViciTheme.destructive, ViciTheme.warning, ViciTheme.success],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(height: 8)
                Circle()
                    .fill(Color(.systemBackground))
                    .overlay(Circle().stroke(ViciTheme.ink, lineWidth: 2))
                    .frame(width: 18, height: 18)
                    .offset(x: max(0, min(geometry.size.width - 18,
                                         (geometry.size.width - 18) * fraction)))
            }
        }
        .frame(height: 20)
        .accessibilityElement()
        .accessibilityLabel("Average customer sentiment")
        .accessibilityValue("\(score.formatted(.number.precision(.fractionLength(1)))) on a scale from negative two to positive two")
    }
}

private struct SentimentShare: View {
    let label: String
    let value: Double?
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(AnalyticsFormatting.percent(value)).font(.subheadline.bold().monospacedDigit())
            Text(label).font(.caption).foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ResponsePerformanceCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let metrics: ResponsePerformanceMetrics
    let trend: Double?

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Response Performance", symbol: "timer")
            HStack(alignment: .top) {
                AnalyticsMetric(value: AnalyticsFormatting.duration(metrics.medianFirstResponseSeconds),
                                label: "Median first response")
                Spacer()
                if let trend { AnalyticsTrend(value: -trend, suffix: "speed") }
            }
            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 16) {
                AnalyticsMetric(value: AnalyticsFormatting.duration(metrics.averageFirstResponseSeconds),
                                label: "Average first response")
                AnalyticsMetric(value: AnalyticsFormatting.percent(metrics.under5MinutesPercent),
                                label: "Under 5 minutes")
                AnalyticsMetric(value: AnalyticsFormatting.percent(metrics.under15MinutesPercent),
                                label: "Under 15 minutes")
                AnalyticsMetric(value: metrics.answeredConversations.formatted(), label: "Answered")
                AnalyticsMetric(value: metrics.unansweredConversations.formatted(), label: "Unanswered")
            }
        }
    }
}

private struct MessagingCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let metrics: MessagingMetrics
    let series: [AnalyticsActivityPoint]
    let trend: Double?
    let granularity: String?
    let timeZoneIdentifier: String

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Messaging", symbol: "message.fill")
            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 10) {
                AnalyticsMetric(value: metrics.outbound.formatted(), label: "Sent")
                AnalyticsMetric(value: metrics.inbound.formatted(), label: "Received")
                AnalyticsMetric(value: AnalyticsFormatting.percent(metrics.replyRate), label: "Reply rate")
            }
            if let trend { AnalyticsTrend(value: trend, suffix: "sent vs previous") }

            if !chartPoints.isEmpty {
                Chart(chartPoints) { point in
                    BarMark(x: .value("Date", point.date),
                            y: .value("Messages", point.outboundMessages))
                        .foregroundStyle(by: .value("Direction", "Sent"))
                        .position(by: .value("Direction", "Sent"))
                        .accessibilityLabel("Sent messages on \(axisLabel(for: point.date))")
                        .accessibilityValue(point.outboundMessages.formatted())
                    BarMark(x: .value("Date", point.date),
                            y: .value("Messages", point.inboundMessages))
                        .foregroundStyle(by: .value("Direction", "Received"))
                        .position(by: .value("Direction", "Received"))
                        .accessibilityLabel("Received messages on \(axisLabel(for: point.date))")
                        .accessibilityValue(point.inboundMessages.formatted())
                }
                .chartForegroundStyleScale(["Sent": ViciTheme.tint, "Received": ViciTheme.avatarFill])
                .chartLegend(position: .bottom, alignment: .leading, spacing: 12)
                .chartXAxis {
                    AxisMarks(values: visibleAxisDates) { value in
                        AxisValueLabel {
                            if let date = value.as(Date.self) {
                                Text(axisLabel(for: date))
                            }
                        }
                    }
                }
                .chartYAxis { AxisMarks(position: .leading) }
                .frame(height: 180)
                .accessibilityLabel("Sent and received messages over time")
            }

            Divider()
            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 12) {
                AnalyticsMetric(value: metrics.conversations.formatted(), label: "Conversations")
                AnalyticsMetric(value: metrics.uniqueCustomersContacted.formatted(), label: "Customers contacted")
                AnalyticsMetric(value: metrics.delivered.formatted(), label: "Delivered")
                AnalyticsMetric(value: metrics.sent.formatted(), label: "Carrier accepted")
                AnalyticsMetric(value: metrics.queued.formatted(), label: "Queued")
                AnalyticsMetric(value: metrics.failed.formatted(), label: "Failed")
                AnalyticsMetric(value: metrics.optOuts.formatted(), label: "Opt-outs / DND")
            }
        }
    }

    private var chartPoints: [MessageChartPoint] {
        series.compactMap { point in
            guard let date = bucketDate(for: point) else { return nil }
            return MessageChartPoint(date: date,
                                     outboundMessages: point.outboundMessages,
                                     inboundMessages: point.inboundMessages)
        }
        .sorted { $0.date < $1.date }
    }

    /// Swift Charts may render every String category even when `desiredCount`
    /// is set. Explicit dates guarantee a readable four-to-seven label range.
    private var visibleAxisDates: [Date] {
        let dates = chartPoints.map(\.date)
        guard dates.count > 7 else { return dates }
        let desired = 6
        let last = dates.count - 1
        var indices = Set<Int>()
        for slot in 0..<desired {
            indices.insert(Int((Double(last) * Double(slot) / Double(desired - 1)).rounded()))
        }
        return indices.sorted().map { dates[$0] }
    }

    private func bucketDate(for point: AnalyticsActivityPoint) -> Date? {
        if let bucketStart = point.bucketStart,
           let parsed = ServerDate.parse(bucketStart) { return parsed }

        let parts = point.date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return ServerDate.parse(point.date) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    private func axisLabel(for date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: timeZoneIdentifier) ?? .current
        switch granularity?.lowercased() {
        case "hour": formatter.dateFormat = "h a"
        case "month": formatter.dateFormat = "MMM yy"
        case "week": formatter.dateFormat = "MMM d"
        default: formatter.dateFormat = "MMM d"
        }
        return formatter.string(from: date)
    }
}

private struct MessageChartPoint: Identifiable {
    let date: Date
    let outboundMessages: Int
    let inboundMessages: Int
    var id: Date { date }
}

private struct CallsAnalyticsCard: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let metrics: CallAnalyticsMetrics
    let trend: Double?

    var body: some View {
        AnalyticsCard {
            AnalyticsSectionHeader(title: "Calls", symbol: "phone.fill")
            LazyVGrid(columns: AnalyticsLayout.columns(for: dynamicTypeSize), spacing: 16) {
                AnalyticsMetric(value: metrics.completed.formatted(), label: "Completed")
                AnalyticsMetric(value: AnalyticsFormatting.duration(metrics.totalTalkSeconds), label: "Talk time")
                AnalyticsMetric(value: metrics.inbound.formatted(), label: "Inbound")
                AnalyticsMetric(value: metrics.outbound.formatted(), label: "Outbound")
                AnalyticsMetric(value: AnalyticsFormatting.percent(metrics.answerRate), label: "Answer rate")
                AnalyticsMetric(value: metrics.missed.formatted(), label: "Missed")
                AnalyticsMetric(value: metrics.uniqueCustomers.formatted(), label: "Unique customers")
                AnalyticsMetric(value: AnalyticsFormatting.duration(metrics.averageDurationSeconds), label: "Average duration")
            }
            if let trend { AnalyticsTrend(value: trend, suffix: "completed vs previous") }
        }
    }
}

private struct AnalyticsSectionHeader: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.headline)
            .foregroundStyle(ViciTheme.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct AnalyticsMetric: View {
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value)
                .font(.title3.bold().monospacedDigit())
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

private struct AnalyticsTrend: View {
    let value: Double
    let suffix: String

    var body: some View {
        Label {
            Text("\(abs(value).formatted(.number.precision(.fractionLength(0...1))))% \(suffix)")
        } icon: {
            Image(systemName: value >= 0 ? "arrow.up.right" : "arrow.down.right")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(value >= 0 ? ViciTheme.success : ViciTheme.destructive)
        .accessibilityLabel("\(value >= 0 ? "Up" : "Down") \(abs(value).formatted()) percent \(suffix)")
    }
}

private struct SentimentChange: View {
    let value: Double

    var body: some View {
        Label {
            Text("\(abs(value).formatted(.number.precision(.fractionLength(0...2)))) points vs previous")
        } icon: {
            Image(systemName: value >= 0 ? "arrow.up.right" : "arrow.down.right")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(value >= 0 ? ViciTheme.success : ViciTheme.destructive)
        .accessibilityLabel("Sentiment \(value >= 0 ? "up" : "down") by \(abs(value).formatted()) points versus previous period")
    }
}

private struct AnalyticsCard<Content: View>: View {
    let emphasized: Bool
    @ViewBuilder let content: Content

    init(emphasized: Bool = false, @ViewBuilder content: () -> Content) {
        self.emphasized = emphasized
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(emphasized ? ViciTheme.tint.opacity(0.35) : Color.primary.opacity(0.05),
                            lineWidth: emphasized ? 1.5 : 1)
            }
    }
}

private enum AnalyticsLayout {
    static let twoColumns = [
        GridItem(.flexible(), alignment: .leading),
        GridItem(.flexible(), alignment: .leading)
    ]

    static func columns(for dynamicTypeSize: DynamicTypeSize) -> [GridItem] {
        dynamicTypeSize.isAccessibilitySize
            ? [GridItem(.flexible(), alignment: .leading)]
            : twoColumns
    }
}

private struct AnalyticsUnavailableView: View {
    let message: String?
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            EmptyState(icon: "chart.bar.xaxis",
                       title: "Analytics unavailable",
                       detail: message ?? "Verified analytics could not be loaded. Your communications are unaffected.")
            Button("Try Again", action: retry).buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct AnalyticsDateRangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var start: Date
    @State private var end: Date
    let apply: (Date, Date) -> Void

    init(start: Date, end: Date, apply: @escaping (Date, Date) -> Void) {
        _start = State(initialValue: start)
        _end = State(initialValue: end)
        self.apply = apply
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Start date").font(.headline)
                        DatePicker("Start date", selection: $start, in: ...Date(), displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .labelsHidden()
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        Text("End date").font(.headline)
                        DatePicker("End date", selection: $end, in: min(start, Date())...Date(), displayedComponents: .date)
                            .datePickerStyle(.graphical)
                            .labelsHidden()
                    }
                }
                .padding()
            }
            .navigationTitle("Custom Range")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Apply") {
                        apply(start, end)
                        dismiss()
                    }
                }
            }
            .onChange(of: start) { value in
                if end < value { end = value }
            }
        }
    }
}

struct AttributionListView: View {
    let query: AnalyticsQuery
    let category: String?
    @StateObject private var model = AttributionListModel()
    @State private var scope: AttributionScope

    init(query: AnalyticsQuery,
         initialScope: AttributionScope = .attributed,
         category: String? = nil) {
        self.query = query
        self.category = category
        _scope = State(initialValue: initialScope)
    }

    var body: some View {
        Group {
            if model.isLoading && model.records.isEmpty {
                ProgressView("Loading audit trail…")
            } else {
                List {
                    Section {
                        Picker("Revenue classification", selection: $scope) {
                            ForEach(AttributionScope.allCases) { option in
                                Text(option.title).tag(option)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                    Section {
                        Text(scopeExplanation)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Section("Orders") {
                        if model.records.isEmpty {
                            EmptyState(icon: "doc.text.magnifyingglass",
                                       title: "No \(scope.title.lowercased()) orders",
                                       detail: model.errorMessage ?? "No orders in this classification were found for the selected period.")
                                .frame(maxWidth: .infinity)
                                .listRowBackground(Color.clear)
                            if model.errorMessage != nil {
                                Button("Try Again") {
                                    Task { await model.load(query: query, scope: scope, category: category, force: true) }
                                }
                                .frame(maxWidth: .infinity)
                            }
                        } else {
                            ForEach(model.records) { record in
                                NavigationLink {
                                    AttributionDetailView(record: record, currency: model.currency)
                                } label: {
                                    AttributionRow(record: record, currency: model.currency)
                                }
                                .task { await model.loadMoreIfNeeded(current: record) }
                            }
                        }
                        if model.isLoadingMore { ProgressView().frame(maxWidth: .infinity) }
                    }
                }
                .refreshable { await model.load(query: query, scope: scope, category: category, force: true) }
            }
        }
        .navigationTitle("Revenue Audit Trail")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(query: query, scope: scope, category: category) }
        .onChange(of: scope) { selected in
            Task { await model.load(query: query, scope: selected, category: category, force: true) }
        }
        .alert("Couldn’t load more", isPresented: Binding(
            get: { model.errorMessage != nil && !model.records.isEmpty },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "Please try again.") }
    }

    private var scopeExplanation: String {
        switch scope {
        case .attributed:
            return category == "payment_recovery"
                ? "Direct and strong payment-recovery orders. Every item includes its rule-based evidence."
                : "Direct and strong orders that make up Attributed Revenue. Every item includes its rule-based evidence."
        case .influenced:
            return "Orders the app may have influenced, kept separate from the stronger Attributed Revenue claim."
        case .unattributed:
            return "Reviewed orders without enough evidence. These are deliberately excluded from all attributed revenue totals."
        }
    }
}

private struct AttributionRow: View {
    let record: AttributionRecord
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(AnalyticsFormatting.money(record.netAmount, currency: currency))
                    .font(.headline.monospacedDigit())
                Spacer()
                Text(record.confidenceLabel.isEmpty ? record.confidenceLevel.title : record.confidenceLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(confidenceColor)
            }
            Text(AnalyticsFormatting.humanized(record.workflow ?? record.category ?? "other"))
                .font(.subheadline.weight(.medium))
            HStack {
                Text("Order #\(record.orderId)")
                Spacer()
                if let conversionAt = record.conversionAt, let date = ServerDate.parse(conversionAt) {
                    Text(date, style: .date)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if record.isRefunded {
                Label("Refund deducted", systemImage: "arrow.uturn.backward")
                    .font(.caption)
                    .foregroundStyle(ViciTheme.destructive)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var confidenceColor: Color {
        switch record.confidenceLevel {
        case .direct: return ViciTheme.success
        case .strong: return ViciTheme.tint
        case .influenced: return ViciTheme.warning
        case .unattributed: return .secondary
        }
    }
}

private struct AttributionDetailView: View {
    let record: AttributionRecord
    let currency: String

    var body: some View {
        List {
            Section("Revenue") {
                LabeledContent("Net", value: AnalyticsFormatting.money(record.netAmount, currency: currency))
                LabeledContent("Gross", value: AnalyticsFormatting.money(record.grossAmount, currency: currency))
                if record.refundedAmount.value != 0 {
                    LabeledContent("Refunded", value: AnalyticsFormatting.money(record.refundedAmount, currency: currency))
                }
            }
            Section("Attribution") {
                LabeledContent("Confidence", value: record.confidenceLabel.isEmpty ? record.confidenceLevel.title : record.confidenceLabel)
                LabeledContent("Workflow", value: AnalyticsFormatting.humanized(record.workflow ?? record.category ?? "other"))
                Text(record.safeExplanation).font(.subheadline)
            }
            Section("Timing") {
                if let actionAt = record.actionAt, let date = ServerDate.parse(actionAt) {
                    LabeledContent("Action", value: date.formatted(date: .abbreviated, time: .shortened))
                }
                if let conversionAt = record.conversionAt, let date = ServerDate.parse(conversionAt) {
                    LabeledContent("Conversion", value: date.formatted(date: .abbreviated, time: .shortened))
                }
                if let seconds = record.attributionWindowSeconds {
                    LabeledContent("Elapsed", value: AnalyticsFormatting.duration(Double(seconds)))
                }
            }
            Section("Audit evidence") {
                LabeledContent("Order", value: "#\(record.orderId)")
                if let action = record.originatingActionType {
                    LabeledContent("Origin", value: AnalyticsFormatting.humanized(action))
                }
                ForEach(record.supportingEvidence, id: \.self) { evidence in
                    Label(AnalyticsFormatting.humanized(evidence), systemImage: "checkmark.seal.fill")
                        .foregroundStyle(ViciTheme.success)
                }
                if record.supportingEvidence.isEmpty {
                    Text("No qualifying evidence, correctly left unattributed.")
                        .foregroundStyle(.secondary)
                }
            }
            if record.invalidatedAt != nil {
                Section {
                    Label("This attribution was invalidated and is excluded from headline totals.",
                          systemImage: "exclamationmark.octagon.fill")
                        .foregroundStyle(ViciTheme.destructive)
                }
            }
        }
        .navigationTitle("Order #\(record.orderId)")
        .navigationBarTitleDisplayMode(.inline)
    }
}

enum AnalyticsFormatting {
    static func money(_ amount: FlexibleDecimal, currency: String) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = currency.isEmpty ? "USD" : currency
        formatter.locale = .current
        formatter.minimumFractionDigits = amount.value.rounded(scale: 0) == amount.value ? 0 : 2
        formatter.maximumFractionDigits = 2
        return formatter.string(from: NSDecimalNumber(decimal: amount.value)) ?? "Not available"
    }

    static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "Not available" }
        return "\(value.formatted(.number.precision(.fractionLength(0...1))))%"
    }

    static func duration(_ seconds: Double?) -> String {
        guard let seconds, seconds.isFinite, seconds >= 0 else { return "Not available" }
        let whole = Int(seconds.rounded())
        if whole < 60 { return "\(whole)s" }
        if whole < 3_600 { return "\(whole / 60)m \(whole % 60)s" }
        return "\(whole / 3_600)h \((whole % 3_600) / 60)m"
    }

    static func humanized(_ value: String) -> String {
        value.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }

}

private extension Decimal {
    func rounded(scale: Int) -> Decimal {
        var source = self
        var result = Decimal()
        NSDecimalRound(&result, &source, scale, .plain)
        return result
    }
}
