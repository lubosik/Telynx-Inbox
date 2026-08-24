import Foundation

/// The existing server reads used by Phase 7. There are deliberately no write
/// requirements in this protocol. APIClient remains the authenticated server
/// boundary and each endpoint keeps its own route-policy permission.
protocol AssistantBusinessAPI: Sendable {
    func fetchAnalyticsOverview(query: AnalyticsQuery) async throws -> AnalyticsOverview
    func fetchAttributions(query: AnalyticsQuery,
                           page: Int,
                           pageSize: Int,
                           scope: AttributionScope,
                           confidence: AttributionConfidence?,
                           category: String?) async throws -> AttributionPage
    func fetchAssistantAuditSummary(from: Date?, to: Date?) async throws -> AssistantAuditSummary
    func fetchActivityStats() async throws -> ActivityStats
    func fetchSegments(page: Int,
                       pageSize: Int,
                       includeArchived: Bool) async throws -> SegmentListPage
    func fetchSegment(id: String,
                      page: Int,
                      pageSize: Int) async throws -> SegmentDetailResponse
    func fetchSegmentMember(id: String, phone: String) async throws -> SegmentMemberDetail
    func fetchSegmentMemberships(phone: String) async throws -> SegmentMembershipSummary
    func fetchCampaigns(page: Int, pageSize: Int) async throws -> CampaignPage
    func fetchCampaignReviewCount() async throws -> Int
    func fetchCampaignPerformance(id: String) async throws -> CampaignPerformance
    func fetchAssistantOpportunityPortfolio() async throws -> AssistantOpportunityPortfolioWire
    func fetchReferrals(box: ReferralBox,
                        includeResolved: Bool) async throws -> [ReferralRecord]
}

extension APIClient: AssistantBusinessAPI {}

/// The privacy-shaped facade used by the fixed Foundation Models Tool layer.
///
/// It never returns provider payloads directly. Each function converts an
/// authenticated GET into a bounded allowlisted DTO and registers the private
/// route identifiers outside model context.
actor AssistantBusinessDataSource {
    private let api: any AssistantBusinessAPI
    private let evidence: AssistantEvidenceRegistry

    init(api: any AssistantBusinessAPI = APIClient.shared,
         evidence: AssistantEvidenceRegistry = AssistantEvidenceRegistry()) {
        self.api = api
        self.evidence = evidence
    }

    func clearEvidence() async {
        await evidence.clear()
    }

    func beginGroundedRequest() async -> AssistantEvidenceGeneration {
        await evidence.beginGeneration()
    }

    func discardGroundedRequest(_ generation: AssistantEvidenceGeneration) async {
        await evidence.discard(generation)
    }

    func commitGroundedRequest(_ generation: AssistantEvidenceGeneration,
                               retaining tokens: Set<AssistantEvidenceToken>) async throws {
        try await evidence.commit(generation, retaining: tokens)
    }

    func releaseEvidence(_ tokens: Set<AssistantEvidenceToken>) async {
        await evidence.remove(tokens: tokens)
    }

    func groundedReferences(for generation: AssistantEvidenceGeneration) async -> [AssistantEvidenceReference] {
        await evidence.references(for: generation)
    }

    func evidenceReference(for token: AssistantEvidenceToken) async -> AssistantEvidenceReference? {
        await evidence.reference(for: token)
    }

    func analytics(query: AnalyticsQuery,
                   generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantAnalyticsSnapshot> {
        await capture(generation: generation) {
            let record = try await api.fetchAnalyticsOverview(query: query)
            guard record.revenue.recoveredRevenue.value >= 0,
                  record.revenue.attributedRevenue.value >= 0,
                  record.revenue.influencedRevenue.value >= 0,
                  record.messaging.outbound >= 0,
                  record.messaging.inbound >= 0,
                  record.calls.completed >= 0 else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let warningCodes = record.warnings.map(\.code)
            let allowedFamilies = AssistantAnalyticsClaimPolicy.allowedFamilies(
                revenueAvailable: record.availability.revenueAttribution,
                messagingAvailable: record.availability.messaging,
                callsAvailable: record.availability.calls,
                warningCodes: warningCodes
            )
            var categoryTokens: [AssistantEvidenceToken] = []
            if allowedFamilies.contains(.revenue) {
                categoryTokens.append(try await evidence.register(
                    source: .analytics,
                    scope: .aggregate,
                    factIDs: ["analytics:revenue:\(record.range.period):\(record.generatedAt)"],
                    claims: [
                        .decimal(metric: "recovered_revenue",
                                 value: record.revenue.recoveredRevenue.value,
                                 currency: record.currency),
                        .decimal(metric: "attributed_revenue",
                                 value: record.revenue.attributedRevenue.value,
                                 currency: record.currency),
                        .decimal(metric: "influenced_revenue",
                                 value: record.revenue.influencedRevenue.value,
                                 currency: record.currency)
                    ],
                    generatedAt: record.generatedAt,
                    destination: .analyticsAttributions(
                        period: record.range.period,
                        start: query.period == .custom ? record.range.start : nil,
                        end: query.period == .custom ? record.range.end : nil,
                        scope: AttributionScope.attributed.rawValue,
                        category: nil
                    ),
                    requiredPermission: .analyticsRead,
                    generation: generation
                ))
            }
            // Messaging and calling totals are intentionally not registered as
            // transcript claims yet. Their raw Inbox/Calls screens require
            // different source permissions, and Analytics has no period-aware
            // messaging or calling drill-down route. A citation must never
            // dismiss Assistant into a screen that cannot substantiate it.
            let token: AssistantEvidenceToken
            if let first = categoryTokens.first {
                token = first
            } else {
                token = try await evidence.register(
                    source: .analytics,
                    scope: .aggregate,
                    factIDs: ["analytics:unavailable:\(record.range.period):\(record.generatedAt)"],
                    claims: [],
                    generatedAt: record.generatedAt,
                    destination: .analyticsAttributions(
                        period: record.range.period,
                        start: query.period == .custom ? record.range.start : nil,
                        end: query.period == .custom ? record.range.end : nil,
                        scope: AttributionScope.attributed.rawValue,
                        category: nil
                    ),
                    requiredPermission: .analyticsRead,
                    generation: generation
                )
            }
            let snapshot = AssistantAnalyticsSnapshot(
                generatedAt: record.generatedAt,
                currency: safeCode(record.currency, fallback: "USD"),
                period: safeCode(record.range.period, fallback: query.period.rawValue),
                start: record.range.start,
                end: record.range.end,
                timeZone: safeLabel(record.range.timeZone, maximum: 80),
                revenueAvailable: record.availability.revenueAttribution,
                messagingAvailable: record.availability.messaging,
                callsAvailable: record.availability.calls,
                revenue: AssistantAnalyticsRevenue(
                    recovered: record.revenue.recoveredRevenue.value,
                    attributed: record.revenue.attributedRevenue.value,
                    influenced: record.revenue.influencedRevenue.value,
                    totalImpact: record.revenue.totalRevenueImpact.value,
                    unattributed: record.revenue.unattributedRevenue.value,
                    refundedAttributed: record.revenue.refundedAttributedRevenue.value,
                    direct: record.revenue.breakdown.direct.netRevenue.value,
                    strong: record.revenue.breakdown.strong.netRevenue.value
                ),
                activity: AssistantAnalyticsActivity(
                    outboundMessages: record.messaging.outbound,
                    inboundMessages: record.messaging.inbound,
                    conversations: record.messaging.conversations,
                    replies: record.messaging.repliesReceived,
                    failedMessages: record.messaging.failed,
                    completedCalls: record.calls.completed,
                    missedCalls: record.calls.missed,
                    totalTalkSeconds: record.calls.totalTalkSeconds,
                    medianFirstResponseSeconds: record.responsePerformance.medianFirstResponseSeconds,
                    unansweredConversations: record.responsePerformance.unansweredConversations
                ),
                sentimentCode: safeSentimentCode(record.sentiment.label),
                sentimentMessagesAnalysed: record.sentiment.messagesAnalyzed,
                notices: safeNotices(warningCodes),
                evidence: token
            )
            let empty = record.revenue.totalRevenueImpact.value == 0
                && record.messaging.total == 0
                && record.calls.total == 0
            return verified(snapshot, generatedAt: record.generatedAt, empty: empty)
        }
    }

    func attributions(query: AnalyticsQuery,
                      page: Int = 1,
                      pageSize: Int = 25,
                      scope: AttributionScope = .attributed,
                      confidence: AttributionConfidence? = nil,
                      category: String? = nil,
                      generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantAttributionSnapshot> {
        await capture(generation: generation) {
            let safePage = max(1, page)
            let safePageSize = min(25, max(1, pageSize))
            let safeCategory = category.flatMap(machineKey)
            let record = try await api.fetchAttributions(
                query: query,
                page: safePage,
                pageSize: safePageSize,
                scope: scope,
                confidence: confidence,
                category: safeCategory
            )
            let route = AssistantEvidenceDestination.analyticsAttributions(
                period: record.range.period,
                start: query.period == .custom ? record.range.start : nil,
                end: query.period == .custom ? record.range.end : nil,
                scope: scope.rawValue,
                category: safeCategory
            )
            var items: [AssistantAttributionItem] = []
            for row in record.items.prefix(safePageSize) {
                let rowToken = try await evidence.register(
                    source: .attribution,
                    scope: .record,
                    factIDs: [row.id, row.orderId, row.originatingActionId].compactMap { $0 },
                    claims: [
                        .decimal(metric: "net_attributed_amount", value: row.netAmount.value,
                                 currency: record.currency),
                        .decimal(metric: "refunded_amount", value: row.refundedAmount.value,
                                 currency: record.currency),
                        .decimal(metric: "confidence_score", value: row.confidenceScore.value,
                                 currency: nil),
                        .code(metric: "confidence", value: row.confidenceLevel.rawValue)
                    ],
                    generatedAt: record.generatedAt,
                    destination: route,
                    requiredPermission: .analyticsRead,
                    generation: generation
                )
                items.append(AssistantAttributionItem(
                    category: row.category.flatMap(machineKey),
                    workflow: row.workflow.flatMap(machineKey),
                    netAmount: row.netAmount.value,
                    refundedAmount: row.refundedAmount.value,
                    confidence: row.confidenceLevel.rawValue,
                    confidenceScore: row.confidenceScore.value,
                    explanation: row.safeExplanation,
                    evidenceCodes: row.supportingEvidence.compactMap(machineKey).prefixArray(12),
                    actionAt: row.actionAt,
                    conversionAt: row.conversionAt,
                    invalidated: row.invalidatedAt != nil,
                    evidence: rowToken
                ))
            }
            let pageToken = try await evidence.register(
                source: .attribution,
                scope: .aggregate,
                factIDs: record.items.prefix(safePageSize).map(\.id),
                claims: [
                    .integer(metric: "attribution_total", value: record.pagination.total),
                    .integer(metric: "attributions_in_page", value: items.count)
                ],
                generatedAt: record.generatedAt,
                destination: route,
                requiredPermission: .analyticsRead,
                generation: generation
            )
            let snapshot = AssistantAttributionSnapshot(
                generatedAt: record.generatedAt,
                currency: safeCode(record.currency, fallback: "USD"),
                period: safeCode(record.range.period, fallback: query.period.rawValue),
                scope: safeCode(record.scope, fallback: scope.rawValue),
                items: items,
                total: record.pagination.total,
                hasMore: record.pagination.hasMore,
                notices: safeNotices(record.warnings.map(\.code)),
                evidence: pageToken
            )
            return verified(snapshot, generatedAt: record.generatedAt, empty: items.isEmpty)
        }
    }

    func activitySummary(from: Date? = nil,
                         to: Date? = nil,
                         generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantActivitySnapshot> {
        await capture(generation: generation) {
            let summary = try await api.fetchAssistantAuditSummary(from: from, to: to)
            guard summary.total >= 0, summary.warnings >= 0,
                  summary.byCategory.values.allSatisfy({ $0 >= 0 }) else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let generatedAt = nowString()
            let pageToken = try await evidence.register(
                source: .activity,
                scope: .aggregate,
                factIDs: ["audit-summary:\(generatedAt)"],
                claims: [
                    .integer(metric: "activity_total", value: summary.total),
                    .integer(metric: "activity_warnings", value: summary.warnings)
                ] + safeCounts(summary.byCategory).sorted(by: { $0.key < $1.key }).map {
                    .integer(metric: "activity_\($0.key)", value: $0.value)
                },
                generatedAt: generatedAt,
                destination: .activity(category: "all"),
                requiredPermission: .auditRead,
                generation: generation
            )
            let snapshot = AssistantActivitySnapshot(
                total: summary.total,
                warnings: summary.warnings,
                byCategory: safeCounts(summary.byCategory),
                evidence: pageToken
            )
            return verified(snapshot, generatedAt: generatedAt, empty: summary.total == 0)
        }
    }

    func automationStatus(generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantAutomationSnapshot> {
        await capture(generation: generation) {
            let record = try await api.fetchActivityStats()
            guard record.pending >= 0 else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let generatedAt = record.updatedAt ?? nowString()
            let token = try await evidence.register(
                source: .automation,
                scope: .aggregate,
                factIDs: ["automation-status:\(generatedAt)"],
                claims: [
                    .integer(metric: "automation_pending", value: record.pending)
                ],
                generatedAt: generatedAt,
                destination: .automations,
                requiredPermission: .automationRead,
                generation: generation
            )
            let snapshot = AssistantAutomationSnapshot(
                pending: record.pending,
                updatedAt: record.updatedAt,
                evidence: token
            )
            let empty = record.pending == 0
            return verified(snapshot, generatedAt: generatedAt, empty: empty)
        }
    }

    func segments(page: Int = 1,
                  pageSize: Int = 20,
                  includeArchived: Bool = false,
                  generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantSegmentListSnapshot> {
        await capture(generation: generation) {
            let safePage = max(1, page)
            let safePageSize = min(20, max(1, pageSize))
            let record = try await api.fetchSegments(page: safePage,
                                                     pageSize: safePageSize,
                                                     includeArchived: includeArchived)
            guard record.total >= 0,
                  record.items.allSatisfy({ $0.memberCount >= 0 }) else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let generatedAt = nowString()
            _ = try await evidence.register(
                source: .segment,
                scope: .aggregate,
                factIDs: ["segment-list:\(generatedAt)"],
                claims: [.integer(metric: "segment_total", value: record.total)],
                generatedAt: generatedAt,
                destination: .segments,
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let items = record.items.prefix(safePageSize).map(segmentSummary)
            let snapshot = AssistantSegmentListSnapshot(
                items: items,
                total: record.total,
                hasMore: safePage * safePageSize < record.total
            )
            return verified(snapshot, generatedAt: generatedAt, empty: record.total == 0)
        }
    }

    func segmentDetail(id: String,
                       page: Int = 1,
                       pageSize: Int = 20,
                       generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantSegmentDetailSnapshot> {
        await capture(generation: generation) {
            let safePage = max(1, page)
            let safePageSize = min(20, max(1, pageSize))
            let record = try await api.fetchSegment(id: String(id.prefix(128)),
                                                    page: safePage,
                                                    pageSize: safePageSize)
            let segment = segmentSummary(record.segment)
            var members: [AssistantSegmentMemberEvidence] = []
            for row in record.members.items.prefix(safePageSize) {
                members.append(try await memberEvidence(segment: record.segment,
                                                        member: row,
                                                        registerEvidence: false,
                                                        generation: generation))
            }
            guard record.members.total >= 0 else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let statusCounts = Dictionary(grouping: members, by: \.status).mapValues { $0.count }
            _ = try await evidence.register(
                source: .segment,
                scope: .aggregate,
                factIDs: [record.segment.id, "stored-evidence"],
                claims: [
                    .integer(metric: "segment_evidence_member_total", value: record.members.total),
                    .integer(metric: "segment_evidence_reviewed_count", value: members.count),
                    .integer(metric: "segment_evidence_automatic_count",
                             value: statusCounts[.automatic] ?? 0),
                    .integer(metric: "segment_evidence_manual_count",
                             value: statusCounts[.manualSelection] ?? 0),
                    .integer(metric: "segment_evidence_override_count",
                             value: statusCounts[.humanOverride] ?? 0),
                    .code(metric: "segment_evidence_has_more",
                          value: safePage * safePageSize < record.members.total ? "true" : "false")
                ],
                generatedAt: nowString(),
                destination: .segment(id: record.segment.id,
                                      name: safeLabel(record.segment.name, maximum: 120)),
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let snapshot = AssistantSegmentDetailSnapshot(
                segment: segment,
                members: members,
                totalMembers: record.members.total,
                hasMore: safePage * safePageSize < record.members.total
            )
            return verified(snapshot, generatedAt: nowString(), empty: record.members.total == 0)
        }
    }

    func segmentMember(segmentID: String,
                       phone: String,
                       generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantSegmentMemberEvidence> {
        await capture(generation: generation) {
            let record = try await api.fetchSegmentMember(id: String(segmentID.prefix(128)), phone: phone)
            let output: AssistantSegmentMemberEvidence
            if let member = record.member {
                output = try await memberEvidence(segment: record.segment,
                                                  member: member,
                                                  registerEvidence: true,
                                                  generation: generation)
            } else {
                let token = try await evidence.register(
                    source: .segment,
                    scope: .record,
                    factIDs: [record.segment.id],
                    claims: [
                        .code(metric: "membership_status", value: "not_a_member")
                    ],
                    generatedAt: nowString(),
                    destination: .segmentMember(segmentID: record.segment.id, phone: phone),
                    requiredPermission: .campaignsRead,
                    generation: generation
                )
                output = AssistantSegmentMemberEvidence(
                    membershipSource: "not_a_member",
                    status: record.activeOverride == nil ? .unavailable : .humanOverride,
                    detector: nil,
                    state: nil,
                    confidence: nil,
                    cadenceSource: nil,
                    ruleVersion: record.segment.ruleVersion.flatMap(machineKey),
                    engineMatched: nil,
                    facts: [],
                    evidence: token
                )
            }
            return verified(output, generatedAt: nowString(), empty: record.member == nil)
        }
    }

    func segmentMemberships(phone: String,
                            generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantSegmentMembershipSnapshot> {
        await capture(generation: generation) {
            let record = try await api.fetchSegmentMemberships(phone: phone)
            var items: [AssistantSegmentMemberEvidence] = []
            for entry in record.memberships.prefix(20) {
                guard let member = entry.member else { continue }
                items.append(try await memberEvidence(segment: entry.segment,
                                                      member: member,
                                                      registerEvidence: false,
                                                      generation: generation))
            }
            guard record.total >= 0 else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let statusCounts = Dictionary(grouping: items, by: \.status).mapValues { $0.count }
            _ = try await evidence.register(
                source: .segment,
                scope: .aggregate,
                factIDs: ["customer-segment-memberships"],
                claims: [
                    .integer(metric: "membership_total", value: record.total),
                    .integer(metric: "membership_reviewed_count", value: items.count),
                    .integer(metric: "membership_automatic_count",
                             value: statusCounts[.automatic] ?? 0)
                ],
                generatedAt: nowString(),
                destination: .segments,
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let snapshot = AssistantSegmentMembershipSnapshot(items: items, total: record.total)
            return verified(snapshot, generatedAt: nowString(), empty: record.total == 0)
        }
    }

    func campaigns(page: Int = 1,
                   pageSize: Int = 20,
                   generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantCampaignListSnapshot> {
        await capture(generation: generation) {
            let safePage = max(1, page)
            let safePageSize = min(20, max(1, pageSize))
            let record = try await api.fetchCampaigns(page: safePage, pageSize: safePageSize)
            let reviewCount = try? await api.fetchCampaignReviewCount()
            guard record.total >= 0,
                  record.items.allSatisfy({ $0.revision >= 0 }),
                  reviewCount.map({ $0 >= 0 }) ?? true else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            let generatedAt = nowString()
            var summaryClaims: [AssistantGroundedClaim] = [
                .integer(metric: "campaign_total", value: record.total)
            ]
            if let reviewCount {
                summaryClaims.append(.integer(metric: "campaign_review_count", value: reviewCount))
            }
            _ = try await evidence.register(
                source: .campaign,
                scope: .aggregate,
                factIDs: ["campaign-list:\(generatedAt)"],
                claims: summaryClaims,
                generatedAt: generatedAt,
                destination: .campaigns,
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let items = record.items.prefix(safePageSize).map { row in
                AssistantCampaignSummary(
                    campaignType: safeCode(row.campaignType, fallback: "campaign"),
                    workflowCategory: safeCode(row.workflowCategory, fallback: "other"),
                    status: row.status.rawValue,
                    revision: row.revision,
                    scheduledFor: row.scheduledFor,
                    completedAt: row.completedAt,
                    updatedAt: row.updatedAt,
                    evidence: nil
                )
            }
            let snapshot = AssistantCampaignListSnapshot(
                items: items,
                reviewCount: reviewCount,
                total: record.total,
                hasMore: safePage * safePageSize < record.total
            )
            return verified(snapshot, generatedAt: generatedAt, empty: record.total == 0)
        }
    }

    func campaignPerformance(id: String,
                             generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantCampaignPerformanceSnapshot> {
        await capture(generation: generation) {
            let safeID = String(id.prefix(128))
            let record = try await api.fetchCampaignPerformance(id: safeID)
            let token = try await evidence.register(
                source: .campaign,
                scope: .aggregate,
                factIDs: [safeID],
                claims: [
                    .integer(metric: "campaign_recipients", value: record.operational.recipients),
                    .integer(metric: "campaign_delivered", value: record.operational.delivered),
                    .integer(metric: "campaign_failed", value: record.operational.failed),
                    .integer(metric: "campaign_replies", value: record.operational.replies),
                    .integer(metric: "campaign_opt_outs", value: record.operational.optOuts)
                ],
                generatedAt: nowString(),
                destination: .campaign(id: safeID),
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let metrics = record.operational
            let snapshot = AssistantCampaignPerformanceSnapshot(
                recipients: metrics.recipients,
                providerAccepted: metrics.providerAccepted,
                delivered: metrics.delivered,
                queued: metrics.queued,
                failed: metrics.failed,
                replies: metrics.replies,
                optOuts: metrics.optOuts,
                operationalAvailable: record.availability.operational,
                financialAvailable: record.availability.financial,
                notices: safeNotices(record.warnings.map(\.code)),
                evidence: token
            )
            return verified(snapshot, generatedAt: nowString(), empty: metrics.recipients == 0)
        }
    }

    func opportunities(generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantOpportunityPortfolioSnapshot> {
        await capture(generation: generation) {
            let record = try await api.fetchAssistantOpportunityPortfolio()
            guard record.findings.allSatisfy({ $0.population >= 0 && $0.actionability.floor >= 0 }) else {
                throw AssistantBusinessFailure(kind: .unavailable)
            }
            _ = try await evidence.register(
                source: .opportunity,
                scope: .aggregate,
                factIDs: [record.detectorVersion, record.computedAt],
                claims: [
                    .integer(metric: "opportunity_count", value: record.findings.count),
                    .integer(metric: "opportunity_actionable_count",
                             value: record.findings.filter { !$0.actionability.belowFloor }.count),
                    .integer(metric: "opportunity_refusal_count", value: record.refusals.count),
                    .code(metric: "opportunity_stale", value: record.freshness.stale ? "true" : "false")
                ],
                generatedAt: record.computedAt,
                destination: .opportunities,
                requiredPermission: .campaignsRead,
                generation: generation
            )
            let selected = Array(record.findings.prefix(5))
            let selectedKeys = Set(selected.map(\.key))
            let findings = selected.map { row in
                AssistantOpportunityFinding(
                    key: safeCode(row.key, fallback: "finding"),
                    population: row.population,
                    actionability: row.actionability,
                    evidence: nil
                )
            }
            let refusals = record.refusals
                .filter { selectedKeys.contains($0.finding) }
                .prefix(12)
                .map {
                    AssistantOpportunityRefusal(
                        finding: safeCode($0.finding, fallback: "finding"),
                        question: safeCode($0.question, fallback: "sizing"),
                        reason: safeCode($0.reason, fallback: "not_supported"),
                        population: $0.population
                    )
                }
            let snapshot = AssistantOpportunityPortfolioSnapshot(
                detectorVersion: safeCode(record.detectorVersion, fallback: "unknown"),
                computedAt: record.computedAt,
                currency: safeCode(record.currency, fallback: "USD"),
                stale: record.freshness.stale,
                ageSeconds: record.freshness.ageSeconds,
                refreshFailureCode: record.freshness.lastRefreshFailure?.code.flatMap(machineKey),
                findings: findings,
                refusals: Array(refusals),
                omissions: record.notBuilt.prefix(12).map {
                    AssistantOpportunityOmission(
                        key: safeCode($0.key, fallback: "omission"),
                        reason: safeCode($0.reason, fallback: "not_supported")
                    )
                },
                blockers: record.blockers.prefix(12).map {
                    AssistantOpportunityBlocker(
                        key: safeCode($0.key, fallback: "blocker"),
                        severity: safeCode($0.severity, fallback: "unknown")
                    )
                }
            )
            return verified(snapshot, generatedAt: record.computedAt, empty: findings.isEmpty)
        }
    }

    func referrals(box: ReferralBox,
                   includeResolved: Bool = false,
                   limit: Int = 50,
                   generation: AssistantEvidenceGeneration) async -> AssistantBusinessOutcome<AssistantReferralListSnapshot> {
        await capture(generation: generation) {
            let safeLimit = min(50, max(1, limit))
            let record = try await api.fetchReferrals(box: box, includeResolved: includeResolved)
            let exhaustive = record.count < 200 && record.count <= safeLimit
            let visible = Array(record.prefix(safeLimit))
            let attentionCount = visible.filter(\.attentionRequired).count
            let generatedAt = nowString()
            _ = try await evidence.register(
                source: .referral,
                scope: .aggregate,
                factIDs: ["referral-list:\(box.rawValue):\(generatedAt)"],
                claims: [
                    .integer(metric: "referral_count", value: min(record.count, safeLimit)),
                    .integer(metric: "referral_attention_count", value: attentionCount),
                    .code(metric: "referral_exhaustive", value: exhaustive ? "true" : "false")
                ],
                generatedAt: generatedAt,
                destination: .referrals,
                requiredPermission: .referralRead,
                generation: generation
            )
            let items = visible.map { row in
                AssistantReferralSummary(
                    targetKind: row.targetKind.rawValue,
                    state: row.state.rawValue,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    attentionRequired: row.attentionRequired,
                    evidence: nil
                )
            }
            let snapshot = AssistantReferralListSnapshot(items: items, exhaustive: exhaustive)
            return verified(snapshot, generatedAt: generatedAt, empty: record.isEmpty)
        }
    }

    // MARK: - Safe mapping

    private func segmentSummary(_ row: SegmentRecord) -> AssistantSegmentSummary {
        return AssistantSegmentSummary(
            kind: row.kind.rawValue,
            memberCount: row.memberCount,
            lastComputedAt: row.lastComputedAt,
            archived: row.isArchived,
            evidence: nil
        )
    }

    private func memberEvidence(segment: SegmentRecord,
                                member: SegmentMember,
                                registerEvidence: Bool,
                                generation: AssistantEvidenceGeneration) async throws -> AssistantSegmentMemberEvidence {
        let automatic = member.membershipSource == .computed
            && ["reorder", "winback", "back_in_stock", "buyer_cohort"]
                .contains(member.evidence.detector ?? "")
        let status: AssistantSegmentEvidenceStatus
        switch member.membershipSource {
        case .computed: status = automatic ? .automatic : .unavailable
        case .forcedInclude: status = .humanOverride
        case .manual: status = .manualSelection
        case .unknown: status = .unavailable
        }
        let facts: [AssistantSegmentFact]
        if automatic {
            facts = automaticFacts(member.evidence)
        } else {
            facts = []
        }
        let token: AssistantEvidenceToken?
        if registerEvidence {
            token = try await evidence.register(
                source: .segment,
                scope: .record,
                factIDs: [segment.id, member.evidence.ruleVersion, member.evidence.detector].compactMap { $0 },
                claims: segmentClaims(member: member, status: status),
                generatedAt: member.lastSeenAt ?? segment.updatedAt,
                destination: .segmentMember(segmentID: segment.id, phone: member.contactPhone),
                requiredPermission: .campaignsRead,
                generation: generation
            )
        } else {
            token = nil
        }
        return AssistantSegmentMemberEvidence(
            membershipSource: member.membershipSource.rawValue,
            status: status,
            detector: member.evidence.detector.flatMap(machineKey),
            state: member.evidence.state.flatMap(machineKey),
            confidence: member.evidence.confidence.flatMap(machineKey),
            cadenceSource: member.evidence.cadenceSource.flatMap(machineKey),
            ruleVersion: member.evidence.ruleVersion.flatMap(machineKey)
                ?? member.evidenceRuleVersion.flatMap(machineKey),
            engineMatched: member.engineMatched,
            facts: facts,
            evidence: token
        )
    }

    private func automaticFacts(_ evidence: SegmentInclusionEvidence) -> [AssistantSegmentFact] {
        var facts: [AssistantSegmentFact] = []
        func number(_ kind: String, _ value: Double?) {
            guard let value, value.isFinite else { return }
            facts.append(AssistantSegmentFact(kind: kind, number: value, date: nil, code: nil))
        }
        func date(_ kind: String, _ value: String?) {
            guard let value, ServerDate.parse(value) != nil else { return }
            facts.append(AssistantSegmentFact(kind: kind, number: nil, date: value, code: nil))
        }
        number("median_interval_days", evidence.medianIntervalDays)
        number("intervals_observed", evidence.intervalsObserved)
        number("cadence_variation_days", evidence.madDays)
        number("purchase_count", evidence.purchaseCount)
        number("lifetime_purchase_count", evidence.lifetimePurchaseCount)
        number("days_since_last_order", evidence.daysSinceLastOrder)
        number("additional_matches", evidence.additionalMatches)
        date("last_order_at", evidence.lastOrderAt)
        date("expected_at", evidence.expectedAt)
        date("added_at", evidence.addedAt)
        return Array(facts.prefix(12))
    }

    private func segmentClaims(member: SegmentMember,
                               status: AssistantSegmentEvidenceStatus) -> [AssistantGroundedClaim] {
        var claims: [AssistantGroundedClaim] = [
            .code(metric: "membership_source", value: member.membershipSource.rawValue),
            .code(metric: "evidence_status", value: status.rawValue)
        ]
        if let detector = member.evidence.detector.flatMap(machineKey) {
            claims.append(.code(metric: "detector", value: detector))
        }
        for fact in automaticFacts(member.evidence) {
            if let number = fact.number {
                let unit = fact.kind.contains("days") ? "days" : "count"
                claims.append(.measurement(metric: fact.kind, value: number, unit: unit))
            } else if let date = fact.date {
                claims.append(.timestamp(metric: fact.kind, value: date))
            } else if let code = fact.code {
                claims.append(.code(metric: fact.kind, value: code))
            }
        }
        return Array(claims.prefix(50))
    }

    private func capture<Value>(generation: AssistantEvidenceGeneration,
                                _ operation: () async throws -> AssistantVerifiedBusinessData<Value>) async -> AssistantBusinessOutcome<Value> {
        do {
            try Task.checkCancellation()
            let activeBeforeRead = await evidence.generation()
            guard generation == activeBeforeRead else { throw CancellationError() }
            let value = try await operation()
            try Task.checkCancellation()
            let activeGeneration = await evidence.generation()
            guard generation == activeGeneration else { throw CancellationError() }
            return .available(value)
        } catch {
            return .unavailable(classify(error))
        }
    }

    private func classify(_ error: Error) -> AssistantBusinessFailure {
        guard let apiError = error as? APIError else {
            return AssistantBusinessFailure(kind: .unavailable)
        }
        switch apiError {
        case .unauthorised:
            return AssistantBusinessFailure(kind: .sessionExpired)
        case .badResponse(let status):
            return AssistantBusinessFailure(kind: failureKind(status: status, code: nil))
        case .server(_, let status, let code):
            return AssistantBusinessFailure(kind: failureKind(status: status, code: code))
        case .decoding, .transport:
            return AssistantBusinessFailure(kind: .unavailable)
        }
    }

    private func failureKind(status: Int?, code: String?) -> AssistantBusinessFailureKind {
        if status == 403 { return .permissionDenied }
        if status == 404 { return .notFound }
        if status == 503 || code?.contains("NOT_READY") == true { return .notReady }
        return .unavailable
    }

    private func verified<Value>(_ value: Value,
                                 generatedAt: String,
                                 empty: Bool) -> AssistantVerifiedBusinessData<Value> {
        AssistantVerifiedBusinessData(value: value,
                                      verifiedAt: generatedAt,
                                      isAuthoritativeEmpty: empty)
    }

    private func safeNotices(_ codes: [String]) -> [AssistantDataNotice] {
        Array(Set(codes).sorted().prefix(20)).map(AssistantDataNotice.safe)
    }

    private func safeCounts(_ values: [String: Int]) -> [String: Int] {
        Dictionary(uniqueKeysWithValues: values.compactMap { key, value in
            machineKey(key).map { ($0, value) }
        })
    }

    private func nowString() -> String {
        ISO8601DateFormatter().string(from: Date())
    }
}

private func safeCode(_ value: String, fallback: String) -> String {
    machineKey(value) ?? fallback
}

private func machineKey(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.count <= 128 else { return nil }
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._:-"))
    guard trimmed.unicodeScalars.allSatisfy(allowed.contains) else { return nil }
    return trimmed
}

private func safeLabel(_ value: String, maximum: Int) -> String {
    let flattened = value
        .replacingOccurrences(of: "\u{2014}", with: "-")
        .components(separatedBy: .controlCharacters)
        .joined(separator: " ")
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")
    return String(flattened.prefix(maximum))
}

private func safeSentimentCode(_ value: String?) -> String? {
    switch value {
    case "Very Upset": return "very_upset"
    case "Upset": return "upset"
    case "Neutral": return "neutral"
    case "Happy": return "happy"
    case "Extremely Happy": return "extremely_happy"
    default: return nil
    }
}

private extension Sequence {
    func prefixArray(_ maximum: Int) -> [Element] {
        Array(prefix(maximum))
    }
}
