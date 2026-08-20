import Foundation

@MainActor
final class AnalyticsViewModel: ObservableObject {
    @Published private(set) var overview: AnalyticsOverview?
    @Published private(set) var isLoading = false
    @Published private(set) var isRefreshing = false
    @Published var errorMessage: String?
    @Published var period: AnalyticsPeriod = .month
    @Published var customStart = Calendar.current.date(byAdding: .month, value: -1, to: Date()) ?? Date()
    @Published var customEnd = Date()

    private var loadID = UUID()
    private var lastLoadedQuery: AnalyticsQuery?
    private var liveRefreshTask: Task<Void, Never>?

    var query: AnalyticsQuery {
        AnalyticsQuery(period: period,
                       start: period == .custom ? customStart : nil,
                       end: period == .custom ? customEnd : nil)
    }

    func load(force: Bool = false) async {
        let requestedQuery = query
        guard force || lastLoadedQuery != requestedQuery || overview == nil else { return }

        let requestID = UUID()
        loadID = requestID
        if overview == nil { isLoading = true } else { isRefreshing = true }
        defer {
            if loadID == requestID {
                isLoading = false
                isRefreshing = false
            }
        }

        do {
            let loaded = try await APIClient.shared.fetchAnalyticsOverview(query: requestedQuery)
            guard loadID == requestID else { return }
            overview = loaded
            lastLoadedQuery = requestedQuery
            errorMessage = nil
        } catch {
            guard loadID == requestID else { return }
            errorMessage = error.localizedDescription
        }
    }

    func applyCustomRange(start: Date, end: Date) async {
        let calendar = Calendar.current
        customStart = calendar.startOfDay(for: min(start, end))
        customEnd = calendar.startOfDay(for: max(start, end))
        period = .custom
        await load(force: true)
    }

    /// Keeps a connection only while Analytics is visible. Events are
    /// invalidations, not incremental arithmetic: the server remains the sole
    /// source of truth and bursts collapse into one fresh aggregate request.
    func listenForChanges() async {
        var reconnectSeconds: UInt64 = 1
        defer { liveRefreshTask?.cancel() }

        while !Task.isCancelled {
            do {
                let stream = try await APIClient.shared.analyticsEvents()
                reconnectSeconds = 1
                for try await event in stream {
                    try Task.checkCancellation()
                    guard Self.refreshingEventTypes.contains(event.type) else { continue }
                    scheduleLiveRefresh()
                }
            } catch is CancellationError {
                return
            } catch APIError.unauthorised {
                return
            } catch {
                // The screen still has pull-to-refresh and foreground refresh.
                // Reconnect quietly rather than replacing valid dashboard data
                // with a transient streaming error.
            }

            do {
                try await Task.sleep(nanoseconds: reconnectSeconds * 1_000_000_000)
            } catch { return }
            reconnectSeconds = min(reconnectSeconds * 2, 30)
        }
    }

    private func scheduleLiveRefresh() {
        liveRefreshTask?.cancel()
        liveRefreshTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 750_000_000) }
            catch { return }
            guard !Task.isCancelled else { return }
            await self?.load(force: true)
        }
    }

    private static let refreshingEventTypes: Set<String> = [
        "new_message", "status_update", "order_status_updated",
        "call_update", "analytics_changed"
    ]
}

@MainActor
final class AttributionListModel: ObservableObject {
    @Published private(set) var records: [AttributionRecord] = []
    @Published private(set) var currency = "USD"
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var hasMore = false
    @Published var errorMessage: String?

    private var page = 0
    private var query: AnalyticsQuery?
    private var scope: AttributionScope = .attributed
    private var category: String?
    private var loadGeneration = UUID()

    func load(query: AnalyticsQuery,
              scope: AttributionScope,
              category: String? = nil,
              force: Bool = false) async {
        guard force || self.query != query || self.scope != scope || self.category != category || records.isEmpty else { return }
        let generation = UUID()
        loadGeneration = generation
        self.query = query
        self.scope = scope
        self.category = category
        page = 0
        records = []
        hasMore = false
        isLoadingMore = false
        await loadPage(1, generation: generation)
    }

    func loadMoreIfNeeded(current record: AttributionRecord) async {
        guard hasMore, records.last?.id == record.id, !isLoadingMore else { return }
        await loadPage(page + 1, generation: loadGeneration)
    }

    private func loadPage(_ requestedPage: Int, generation: UUID) async {
        guard let query else { return }
        let requestedScope = scope
        let requestedCategory = category
        if requestedPage == 1 { isLoading = true } else { isLoadingMore = true }
        defer {
            if loadGeneration == generation {
                isLoading = false
                isLoadingMore = false
            }
        }
        do {
            let response = try await APIClient.shared.fetchAttributions(query: query,
                                                                         page: requestedPage,
                                                                         scope: requestedScope,
                                                                         category: requestedCategory)
            guard loadGeneration == generation,
                  self.query == query,
                  self.scope == requestedScope,
                  self.category == requestedCategory else { return }
            if requestedPage == 1 {
                records = response.items
            } else {
                let existing = Set(records.map(\.id))
                records.append(contentsOf: response.items.filter { !existing.contains($0.id) })
            }
            currency = response.currency
            page = response.pagination.page
            hasMore = response.pagination.hasMore
            errorMessage = nil
        } catch {
            guard loadGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
    }
}
