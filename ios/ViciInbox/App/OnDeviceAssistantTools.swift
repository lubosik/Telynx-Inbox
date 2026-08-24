import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

private enum AssistantToolFailure: Error {
    case invalidArguments
    case permissionDenied
    case capabilityDisabled
    case callBudgetExceeded
    case unavailable
}

private struct AssistantToolAuthorization: Sendable {
    let permissions: Set<String>
    let refreshCapability: @Sendable () async throws -> AssistantCapabilityStatus

    func verify(required permissionsForTool: Set<String>) async throws {
        try Task.checkCancellation()
        guard permissions.contains(Permission.assistantUse),
              permissionsForTool.isSubset(of: permissions) else {
            throw AssistantToolFailure.permissionDenied
        }
        let status = try await refreshCapability()
        try Task.checkCancellation()
        guard status.enabled,
              status.mode == AssistantCapabilityStatus.supportedMode else {
            throw AssistantToolFailure.capabilityDisabled
        }
    }
}

private actor AssistantToolBudget {
    private let maximumCalls: Int
    private var usedNames: Set<String> = []

    init(maximumCalls: Int) {
        self.maximumCalls = maximumCalls
    }

    func consume(name: String) throws {
        try Task.checkCancellation()
        guard usedNames.count < maximumCalls, usedNames.insert(name).inserted else {
            throw AssistantToolFailure.callBudgetExceeded
        }
    }
}

#if canImport(FoundationModels)
/// One Xcode 26-compatible Tool implementation. Each instance has one fixed,
/// reviewed read closure and a unique name. Tool output contains no DTO, claim,
/// identifier, token, or server prose. Verified values remain in the private
/// evidence registry and the app renders them after generation finishes.
@available(iOS 26.0, *)
private struct AssistantFixedReadTool: Tool {
    let name: String
    let description: String
    let requiredPermissions: Set<String>
    let authorization: AssistantToolAuthorization
    let budget: AssistantToolBudget
    let operation: @Sendable () async throws -> Void

    @Generable
    struct Arguments {
        @Guide(description: "Use the single reviewed read operation.", .anyOf(["read"]))
        var operation: String
    }

    func call(arguments: Arguments) async throws -> String {
        guard arguments.operation == "read" else { throw AssistantToolFailure.invalidArguments }
        try await authorization.verify(required: requiredPermissions)
        try await budget.consume(name: name)
        try Task.checkCancellation()
        try await operation()
        try Task.checkCancellation()
        return "Verified data captured."
    }
}

@available(iOS 26.0, *)
@MainActor
private final class OnDeviceAssistantBusinessReasoner {
    private let model: SystemLanguageModel
    private let dataSource: AssistantBusinessDataSource
    private var resetTask: Task<Void, Never>?
    private var resetSequence = 0

    init(model: SystemLanguageModel = .default,
         dataSource: AssistantBusinessDataSource = AssistantBusinessDataSource()) {
        self.model = model
        self.dataSource = dataSource
    }

    func respond(intent: AssistantBusinessIntent,
                 userText: String,
                 permissions: Set<String>) async throws -> AssistantGroundedResponse {
        let lifecycleSequence = resetSequence
        await finishPendingReset()
        try Task.checkCancellation()
        guard lifecycleSequence == resetSequence else { throw CancellationError() }
        guard case .available = model.availability else { return .unverified }
        guard permissions.contains(Permission.assistantUse),
              intent.requiredPermissions.isSubset(of: permissions) else {
            return .unverified
        }

        let generation = await dataSource.beginGroundedRequest()
        let authorization = AssistantToolAuthorization(
            permissions: permissions,
            refreshCapability: { try await APIClient.shared.fetchAssistantStatus() }
        )
        let budget = AssistantToolBudget(maximumCalls: 1)
        guard let tool = makeTool(intent: intent,
                                  generation: generation,
                                  permissions: permissions,
                                  authorization: authorization,
                                  budget: budget) else {
            await dataSource.discardGroundedRequest(generation)
            return .unverified
        }

        let session = LanguageModelSession(model: model, tools: [tool]) {
            AssistantPromptCatalog.groundedTools.instructions
        }
        let prompt = Prompt {
            "Use the single supplied read tool for this supported request."
            "The person's request is: \(userText)"
        }

        do {
            try Task.checkCancellation()
            let response = try await session.respond(to: prompt)
            try Task.checkCancellation()
            guard lifecycleSequence == resetSequence else { throw CancellationError() }
            let references = await dataSource.groundedReferences(for: generation)
            try Task.checkCancellation()
            guard lifecycleSequence == resetSequence else { throw CancellationError() }
            let rendered = AssistantGroundedRenderer.render(
                intent: intent,
                references: references,
                modelText: response.content
            )
            if rendered.citations.isEmpty {
                await dataSource.discardGroundedRequest(generation)
            } else {
                try await dataSource.commitGroundedRequest(
                    generation,
                    retaining: Set(rendered.citations.map(\.token))
                )
            }
            return rendered
        } catch is CancellationError {
            await dataSource.discardGroundedRequest(generation)
            throw CancellationError()
        } catch is LanguageModelSession.ToolCallError {
            await dataSource.discardGroundedRequest(generation)
            return .unverified
        } catch is LanguageModelSession.GenerationError {
            await dataSource.discardGroundedRequest(generation)
            return .unverified
        } catch {
            await dataSource.discardGroundedRequest(generation)
            return .unverified
        }
    }

    func evidenceRoute(for token: AssistantEvidenceToken,
                       initiatingIdentity: AssistantIdentitySnapshot) async -> AppRoute? {
        let lifecycleSequence = resetSequence
        await finishPendingReset()
        guard lifecycleSequence == resetSequence,
              initiatingIdentity.permissionSet.contains(Permission.assistantUse),
              let reference = await dataSource.evidenceReference(for: token) else {
            return nil
        }
        do {
            async let capabilityRead = APIClient.shared.fetchAssistantStatus()
            async let identityRead = APIClient.shared.fetchCurrentUserStrict()
            let (capability, currentUser) = try await (capabilityRead, identityRead)
            try Task.checkCancellation()
            let freshIdentity = AssistantIdentitySnapshot(user: currentUser)
            guard lifecycleSequence == resetSequence,
                  freshIdentity == initiatingIdentity,
                  AssistantAccess.isPermitted(for: currentUser),
                  capability.enabled,
                  capability.mode == AssistantCapabilityStatus.supportedMode else {
                reset()
                return nil
            }
            return AssistantEvidenceRouteResolver.route(
                for: reference,
                permissions: freshIdentity.permissionSet
            )
        } catch {
            return nil
        }
    }

    func reset() {
        resetSequence += 1
        let prior = resetTask
        let source = dataSource
        resetTask = Task {
            if let prior { await prior.value }
            await source.clearEvidence()
        }
    }

    func releaseEvidence(_ tokens: [AssistantEvidenceToken]) async {
        guard !tokens.isEmpty else { return }
        await dataSource.releaseEvidence(Set(tokens))
    }

    private func finishPendingReset() async {
        while let pending = resetTask {
            let observedSequence = resetSequence
            await pending.value
            guard observedSequence == resetSequence else { continue }
            resetTask = nil
            return
        }
    }

    private func makeTool(intent: AssistantBusinessIntent,
                          generation: AssistantEvidenceGeneration,
                          permissions: Set<String>,
                          authorization: AssistantToolAuthorization,
                          budget: AssistantToolBudget) -> AssistantFixedReadTool? {
        let source = dataSource
        switch intent {
        case .analytics(let period):
            return tool(name: "read_analytics_overview",
                        description: "Reads the verified Vici analytics overview for the selected fixed period.",
                        required: [Permission.analyticsRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.analytics(
                    query: AnalyticsQuery(period: period, start: nil, end: nil),
                    generation: generation
                ))
            }

        case .activity:
            return tool(name: "read_activity_summary",
                        description: "Reads bounded aggregate Vici activity counts without event content.",
                        required: [Permission.auditRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.activitySummary(generation: generation))
            }

        case .automation:
            return tool(name: "read_automation_status",
                        description: "Reads the verified pending automation count.",
                        required: [Permission.automationRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.automationStatus(generation: generation))
            }

        case .segments:
            return tool(name: "read_segment_summary",
                        description: "Reads a bounded summary of saved segment membership counts.",
                        required: [Permission.campaignsRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.segments(page: 1, pageSize: 20,
                                                           includeArchived: false,
                                                           generation: generation))
            }

        case .segmentEvidence(let target):
            return tool(name: "read_stored_segment_evidence",
                        description: "Reads bounded, allowlisted stored segment evidence for trusted on-screen context. It excludes human prose.",
                        required: [Permission.campaignsRead], authorization: authorization, budget: budget) {
                switch target {
                case .segment(let id):
                    try requireAvailable(await source.segmentDetail(
                        id: id, page: 1, pageSize: 20, generation: generation
                    ))
                case .member(let segmentID, let phone):
                    try requireAvailable(await source.segmentMember(
                        segmentID: segmentID, phone: phone, generation: generation
                    ))
                case .memberships(let phone):
                    try requireAvailable(await source.segmentMemberships(
                        phone: phone, generation: generation
                    ))
                }
            }

        case .campaigns:
            return tool(name: "read_campaign_status",
                        description: "Reads a bounded campaign status and review summary.",
                        required: [Permission.campaignsRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.campaigns(page: 1, pageSize: 20,
                                                            generation: generation))
            }

        case .opportunities:
            return tool(name: "read_opportunity_portfolio",
                        description: "Reads the cached verified opportunity portfolio and its honesty metadata.",
                        required: [Permission.campaignsRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.opportunities(generation: generation))
            }

        case .referrals:
            return tool(name: "read_referral_summary",
                        description: "Reads a bounded received referral status summary without notes or identities.",
                        required: [Permission.referralRead], authorization: authorization, budget: budget) {
                try requireAvailable(await source.referrals(box: .received,
                                                            includeResolved: false,
                                                            limit: 50,
                                                            generation: generation))
            }

        case .executiveBrief:
            let readable = permissions.intersection([
                Permission.analyticsRead,
                Permission.campaignsRead,
                Permission.referralRead
            ])
            guard !readable.isEmpty else { return nil }
            return tool(name: "read_executive_brief",
                        description: "Reads a minimal verified executive summary from the Vici sources this account may access.",
                        required: [], authorization: authorization, budget: budget) {
                var verified = false
                if readable.contains(Permission.analyticsRead) {
                    verified = isAvailable(await source.analytics(
                        query: AnalyticsQuery(period: .month, start: nil, end: nil),
                        generation: generation
                    )) || verified
                }
                if readable.contains(Permission.campaignsRead) {
                    verified = isAvailable(await source.campaigns(page: 1, pageSize: 20,
                                                                  generation: generation)) || verified
                    verified = isAvailable(await source.opportunities(generation: generation)) || verified
                }
                if readable.contains(Permission.referralRead) {
                    verified = isAvailable(await source.referrals(box: .received,
                                                                  includeResolved: false,
                                                                  limit: 50,
                                                                  generation: generation)) || verified
                }
                guard verified else { throw AssistantToolFailure.unavailable }
            }
        }
    }

    private func tool(name: String,
                      description: String,
                      required: Set<String>,
                      authorization: AssistantToolAuthorization,
                      budget: AssistantToolBudget,
                      operation: @escaping @Sendable () async throws -> Void) -> AssistantFixedReadTool {
        AssistantFixedReadTool(name: name,
                               description: description,
                               requiredPermissions: required,
                               authorization: authorization,
                               budget: budget,
                               operation: operation)
    }
}

private func requireAvailable<Value>(_ outcome: AssistantBusinessOutcome<Value>) throws {
    guard isAvailable(outcome) else {
        if case .unavailable(let failure) = outcome { throw failure }
        throw AssistantToolFailure.unavailable
    }
}

private func isAvailable<Value>(_ outcome: AssistantBusinessOutcome<Value>) -> Bool {
    if case .available = outcome { return true }
    return false
}
#endif

@MainActor
extension AssistantBusinessReasoningOperations {
    static func systemDefault() -> AssistantBusinessReasoningOperations {
#if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let reasoner = OnDeviceAssistantBusinessReasoner()
            return AssistantBusinessReasoningOperations(
                respond: { try await reasoner.respond(intent: $0, userText: $1, permissions: $2) },
                evidenceRoute: { await reasoner.evidenceRoute(for: $0, initiatingIdentity: $1) },
                releaseEvidence: { await reasoner.releaseEvidence($0) },
                reset: { reasoner.reset() }
            )
        }
#endif
        return AssistantBusinessReasoningOperations(
            respond: { _, _, _ in .unverified },
            evidenceRoute: { _, _ in nil },
            releaseEvidence: { _ in },
            reset: {}
        )
    }
}
