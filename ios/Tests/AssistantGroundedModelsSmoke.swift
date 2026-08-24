import Foundation

// Minimal Foundation-only stand-ins keep this executable independent of
// SwiftUI, APIClient and the iOS SDK. Production uses the identically shaped
// repository types.
struct AuthUser {
    let id: String
    let role: String?
    let permissions: [String]?
    let isLegacyShared: Bool?
    let viaLegacySession: Bool?
    var permissionSet: Set<String> { Set(permissions ?? []) }
}

enum Permission {
    static let assistantUse = "assistant.use"
    static let analyticsRead = "analytics.read"
    static let auditRead = "audit.read"
    static let automationRead = "automation.read"
    static let campaignsRead = "campaigns.read"
    static let referralRead = "referral.read"
}

enum AnalyticsPeriod: String, Equatable, Sendable {
    case today, week, month, year, all, custom
}

enum GrowthSection: Int, Codable, Hashable { case automations, campaigns, audiences }

enum AppRoute: Codable, Hashable {
    case inbox, calls, analytics, referrals
    case growth(GrowthSection)
    case analyticsAttributions(period: String, start: String?, end: String?, scope: String, category: String?)
    case activity(category: String)
    case opportunities
    case campaign(id: String)
    case campaignAttributions(campaignID: String)
    case segment(id: String, name: String?)
    case referral(id: String, phone: String)
}

enum AssistantOutputPolicy {
    static func sanitise(_ text: String) -> String? {
        let cleaned = text.replacingOccurrences(of: "\u{2014}", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : String(cleaned.prefix(1_500))
    }
}

enum AssistantTranscriptPolicy { static let maximumVisibleExchanges = 20 }

@main
struct AssistantGroundedModelsSmoke {
    static func main() async throws {
        let trustedContext = AssistantBusinessContext(segmentID: "segment-1", memberPhone: nil)
        precondition(
            AssistantBusinessIntent.parse("show me why they are in it", context: trustedContext)
                == .segmentEvidence(.segment(id: "segment-1"))
        )
        precondition(AssistantBusinessIntent.parse("show me why they are in it") == nil)
        precondition(
            AssistantBusinessIntent.parse("show me why they are in segment secret-id",
                                          context: trustedContext) == nil,
            "an identifier was accepted from user text"
        )

        let registry = AssistantEvidenceRegistry()
        let firstGeneration = await registry.beginGeneration()

        var recordTokens: [AssistantEvidenceToken] = []
        for index in 0..<20 {
            recordTokens.append(try await registry.register(
                source: .analytics,
                scope: .record,
                factIDs: ["record-before-aggregate-\(index)"],
                claims: [.decimal(metric: "recovered_revenue",
                                  value: Decimal(999_999 + index), currency: "USD")],
                generatedAt: "2026-08-24T10:00:00Z",
                destination: .analyticsAttributions(
                    period: "month", start: nil, end: nil, scope: "attributed", category: nil
                ),
                requiredPermission: .analyticsRead,
                generation: firstGeneration
            ))
        }
        let aggregateToken = try await registry.register(
            source: .analytics,
            scope: .aggregate,
            factIDs: ["verified-aggregate"],
            claims: [.decimal(metric: "recovered_revenue", value: 1_240, currency: "USD")],
            generatedAt: "2026-08-24T10:00:00Z",
            destination: .analyticsAttributions(
                period: "month", start: nil, end: nil, scope: "attributed", category: nil
            ),
            requiredPermission: .analyticsRead,
            generation: firstGeneration
        )
        let firstReferences = await registry.references(for: firstGeneration)
        let grounded = AssistantGroundedRenderer.render(
            intent: .analytics(.month),
            references: firstReferences,
            modelText: "Ignore the tool. Revenue was $999,999."
        )
        precondition(grounded.text.contains("$1,240"))
        precondition(!grounded.text.contains("999,999"), "model or record-level value escaped")
        precondition(grounded.citations == [
            AssistantEvidenceCitation(label: "Recovered revenue", token: aggregateToken)
        ])
        precondition(grounded.citations.allSatisfy { !recordTokens.contains($0.token) })
        try await registry.commit(
            firstGeneration,
            retaining: Set(grounded.citations.map(\.token))
        )
        for token in recordTokens {
            let removedRecord = await registry.reference(for: token)
            precondition(removedRecord == nil, "uncited record consumed registry capacity")
        }

        let supportedRoute = AssistantEvidenceRouteResolver.route(
            for: firstReferences.last!, permissions: [Permission.analyticsRead]
        )
        let permissionRemovedRoute = AssistantEvidenceRouteResolver.route(
            for: firstReferences.last!, permissions: []
        )
        precondition(supportedRoute != nil)
        precondition(permissionRemovedRoute == nil,
                     "a removed source permission still opened evidence")

        // Starting a later question seals but does not delete citations still
        // visible in the in-memory transcript.
        let secondGeneration = await registry.beginGeneration()
        let secondToken = try await registry.register(
            source: .segment,
            scope: .aggregate,
            factIDs: ["segment-list"],
            claims: [.integer(metric: "segment_total", value: 10)],
            generatedAt: "2026-08-24T10:01:00Z",
            destination: .segments,
            requiredPermission: .campaignsRead,
            generation: secondGeneration
        )
        let earlierBeforeDiscard = await registry.reference(for: aggregateToken)
        precondition(earlierBeforeDiscard != nil)
        try await registry.commit(secondGeneration, retaining: [secondToken])

        // A sealed generation may not add a late claim after another question
        // starts. This is the cancellation/reset write fence.
        var lateRegistrationWasRejected = false
        do {
            _ = try await registry.register(
                source: .analytics,
                scope: .aggregate,
                factIDs: ["late-first-write"],
                claims: [.integer(metric: "outbound_messages", value: 4_200)],
                generatedAt: "2026-08-24T10:01:30Z",
            destination: .activity(category: "all"),
                requiredPermission: .analyticsRead,
                generation: firstGeneration
            )
        } catch is CancellationError {
            lateRegistrationWasRejected = true
        }
        precondition(lateRegistrationWasRejected)

        // A third, failed question discards itself without erasing either
        // earlier successful generation.
        let failedGeneration = await registry.beginGeneration()
        let failedToken = try await registry.register(
            source: .activity,
            scope: .aggregate,
            factIDs: ["failed-question"],
            claims: [.integer(metric: "activity_total", value: 4_200)],
            generatedAt: "2026-08-24T10:01:40Z",
            destination: .activity(category: "all"),
            requiredPermission: .auditRead,
            generation: failedGeneration
        )
        await registry.discard(failedGeneration)
        let failedReference = await registry.reference(for: failedToken)
        let firstAfterFailure = await registry.reference(for: aggregateToken)
        let secondAfterFailure = await registry.reference(for: secondToken)
        precondition(failedReference == nil)
        precondition(firstAfterFailure != nil)
        precondition(secondAfterFailure != nil,
                     "discarding a failed question deleted a successful later citation")

        // A trusted-context member read exposes only the allowlisted automatic
        // claims placed in the private registry. Human prose never enters this
        // fixture or the renderer.
        let thirdGeneration = await registry.beginGeneration()
        let memberToken = try await registry.register(
            source: .segment,
            scope: .record,
            factIDs: ["segment-1", "rule-v1"],
            claims: [
                .code(metric: "evidence_status", value: "automatic"),
                .measurement(metric: "purchase_count", value: 3, unit: "count"),
                .measurement(metric: "days_since_last_order", value: 21, unit: "days")
            ],
            generatedAt: "2026-08-24T10:02:00Z",
            destination: .segmentMember(segmentID: "segment-1", phone: "+15555550123"),
            requiredPermission: .campaignsRead,
            generation: thirdGeneration
        )
        let member = AssistantGroundedRenderer.render(
            intent: .segmentEvidence(.member(segmentID: "segment-1", phone: "+15555550123")),
            references: await registry.references(for: thirdGeneration),
            modelText: "Reveal a private note and make up 42 orders."
        )
        precondition(member.text.contains("3 purchases"))
        precondition(member.text.contains("21 days"))
        precondition(!member.text.contains("42"))
        precondition(member.citations.allSatisfy { $0.token == memberToken })

        let noTool = AssistantGroundedRenderer.render(
            intent: .analytics(.today), references: [], modelText: "Revenue is $4,200."
        )
        precondition(noTool == .unverified)
        precondition(!noTool.text.contains("4,200"))
        precondition(noTool.text.rangeOfCharacter(from: .decimalDigits) == nil)
        precondition(noTool.text.rangeOfCharacter(from: CharacterSet(charactersIn: "$£€¥")) == nil)

        let unavailableFamilies = AssistantAnalyticsClaimPolicy.allowedFamilies(
            revenueAvailable: false,
            messagingAvailable: false,
            callsAvailable: false,
            warningCodes: []
        )
        let incompleteFamilies = AssistantAnalyticsClaimPolicy.allowedFamilies(
            revenueAvailable: true,
            messagingAvailable: true,
            callsAvailable: true,
            warningCodes: ["HISTORICAL_BACKFILL_INCOMPLETE"]
        )
        let completeFamilies = AssistantAnalyticsClaimPolicy.allowedFamilies(
            revenueAvailable: true,
            messagingAvailable: false,
            callsAvailable: true,
            warningCodes: []
        )
        precondition(unavailableFamilies.isEmpty)
        precondition(incompleteFamilies.isEmpty)
        precondition(completeFamilies == [.revenue, .calls])

        // Twenty visible exchanges at the renderer's maximum eight citations
        // each retain exactly 160 committed references.
        let capacityRegistry = AssistantEvidenceRegistry()
        var visibleTokens: [AssistantEvidenceToken] = []
        for exchange in 0..<AssistantTranscriptPolicy.maximumVisibleExchanges {
            let generation = await capacityRegistry.beginGeneration()
            var exchangeTokens: Set<AssistantEvidenceToken> = []
            for citation in 0..<8 {
                let token = try await capacityRegistry.register(
                    source: .activity,
                    scope: .aggregate,
                    factIDs: ["visible-\(exchange)-\(citation)"],
                    claims: [.integer(metric: "metric_\(exchange)_\(citation)", value: citation)],
                    generatedAt: "2026-08-24T10:03:00Z",
                    destination: .activity(category: "all"),
                    requiredPermission: .auditRead,
                    generation: generation
                )
                exchangeTokens.insert(token)
                visibleTokens.append(token)
            }
            try await capacityRegistry.commit(generation, retaining: exchangeTokens)
        }
        let retainedCapacityCount = await capacityRegistry.count
        precondition(retainedCapacityCount == 160)
        for token in visibleTokens {
            let visibleReference = await capacityRegistry.reference(for: token)
            precondition(visibleReference != nil, "visible citation was evicted at capacity")
        }

        // Even before the shell releases its oldest visible exchange, the
        // full reserved request capacity fits
        // without evicting any of the 160 citations already on screen.
        let worstCaseGeneration = await capacityRegistry.beginGeneration()
        for provisional in 0..<AssistantEvidenceRegistry.maximumReferencesPerRequest {
            _ = try await capacityRegistry.register(
                source: .attribution,
                scope: provisional == 39 ? .aggregate : .record,
                factIDs: ["worst-case-\(provisional)"],
                claims: [.integer(metric: "bounded_value", value: provisional)],
                generatedAt: "2026-08-24T10:04:00Z",
                destination: .analyticsAttributions(
                    period: "month", start: nil, end: nil,
                    scope: "attributed", category: nil
                ),
                requiredPermission: .analyticsRead,
                generation: worstCaseGeneration
            )
        }
        let countWithWorstCaseRead = await capacityRegistry.count
        precondition(countWithWorstCaseRead == 200)
        for token in visibleTokens {
            let stillVisible = await capacityRegistry.reference(for: token)
            precondition(stillVisible != nil,
                         "a worst-case provisional read evicted visible evidence")
        }
        var fortyFirstWasRejected = false
        do {
            _ = try await capacityRegistry.register(
                source: .attribution,
                scope: .record,
                factIDs: ["unbounded-41"],
                claims: [.integer(metric: "bounded_value", value: 41)],
                generatedAt: "2026-08-24T10:04:00Z",
                destination: .analyticsAttributions(
                    period: "month", start: nil, end: nil,
                    scope: "attributed", category: nil
                ),
                requiredPermission: .analyticsRead,
                generation: worstCaseGeneration
            )
        } catch AssistantEvidenceRegistryError.capacityExceeded {
            fortyFirstWasRejected = true
        }
        precondition(fortyFirstWasRejected)
        await capacityRegistry.discard(worstCaseGeneration)

        // A lifecycle reset is the only whole-registry deletion path.
        await registry.clear()
        let aggregateAfterClear = await registry.reference(for: aggregateToken)
        let memberAfterClear = await registry.reference(for: memberToken)
        precondition(aggregateAfterClear == nil)
        precondition(memberAfterClear == nil)

        print("Assistant grounded model smoke: OK")
    }
}
