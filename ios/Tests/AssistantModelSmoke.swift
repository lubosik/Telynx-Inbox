import Foundation

/// Minimal stand-in so this executable can compile AssistantModel without the
/// production networking layer. The injected loader below is the only loader
/// the smoke actually invokes.
@MainActor
final class APIClient {
    static let shared = APIClient()

    func fetchAssistantStatus() async throws -> AssistantCapabilityStatus {
        throw SmokeFailure.unexpectedDefaultLoader
    }
}

private enum SmokeFailure: Error {
    case unexpectedDefaultLoader
    case groundedToolFailed
}

private actor DelayedGreetingGate {
    private var started = false
    private var continuation: CheckedContinuation<String, Never>?

    func response() async -> String {
        started = true
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
    }

    func waitUntilStarted() async {
        while !started {
            await Task.yield()
        }
    }

    func release() {
        continuation?.resume(returning: "Hello, this late response must be discarded.")
        continuation = nil
    }
}

@main
@MainActor
struct AssistantModelSmoke {
    static func main() async throws {
        let enabled = AssistantCapabilityStatus(
            enabled: true,
            mode: AssistantCapabilityStatus.supportedMode,
            minimumOSMajor: 26,
            reason: nil
        )
        var respondCount = 0
        let reasoning = AssistantReasoningOperations(
            availability: { .available },
            prewarm: {},
            respond: { _ in
                respondCount += 1
                return "Vici made $999,999 today."
            },
            reset: {}
        )
        let model = AssistantModel(
            loadCapability: { enabled },
            reasoning: reasoning
        )

        model.draft = "How much revenue did Vici make today?"
        let response = await model.submit(callIsActive: false, currentOSMajor: 26)

        precondition(respondCount == 0, "business request reached the no-tools model")
        precondition(response == AssistantReasoningScope.unavailableDataMessage)
        precondition(response?.contains("999,999") == false)
        precondition(model.transcript.count == 2)
        precondition(model.transcript.last?.text == AssistantReasoningScope.unavailableDataMessage)
        precondition(model.transcript.allSatisfy { !$0.text.contains("999,999") })
        precondition(model.phase == .thinking, "speech owns the final transition")
        model.noteSpeechFinished()
        precondition(model.phase == .idle)

        model.draft = "Hello"
        let greeting = await model.submit(callIsActive: false, currentOSMajor: 26)
        precondition(respondCount == 1, "eligible greeting did not reach the model once")
        precondition(greeting == AssistantGreetingOutputPolicy.fallback)
        precondition(greeting?.contains("999,999") == false)
        precondition(model.transcript.last?.text == AssistantGreetingOutputPolicy.fallback)
        precondition(model.transcript.allSatisfy { !$0.text.contains("999,999") })

        let actorJSON = """
        {"id":"owner-1","displayName":"Owner","email":"owner@example.test",
         "role":"owner","permissions":["assistant.use","analytics.read"],
         "mustChangePassword":false,"isLegacyShared":false,"viaLegacySession":false}
        """.data(using: .utf8)!
        let owner = try JSONDecoder().decode(AuthUser.self, from: actorJSON)
        let citationToken = AssistantEvidenceToken(value: "reviewed-revenue")
        var businessResetCount = 0
        let groundedModel = AssistantModel(
            loadCapability: { enabled },
            reasoning: reasoning,
            businessReasoning: AssistantBusinessReasoningOperations(
                respond: { _, _, _ in
                    AssistantGroundedResponse(
                        text: "Recovered revenue this month is $1,240.",
                        citations: [AssistantEvidenceCitation(
                            label: "Recovered revenue", token: citationToken
                        )]
                    )
                },
                evidenceRoute: { _, _ in nil },
                releaseEvidence: { _ in },
                reset: { businessResetCount += 1 }
            )
        )
        groundedModel.draft = "show analytics"
        let groundedText = await groundedModel.submit(
            callIsActive: false, user: owner, currentOSMajor: 26
        )
        precondition(groundedText?.contains("$1,240") == true)
        precondition(groundedModel.transcript.last?.citations.first?.token == citationToken)

        // A failed fresh capability/identity/permission recheck on tap fails
        // closed at the shell, removing the visible figure and resetting the
        // private reasoning/evidence session.
        let missingRoute = await groundedModel.evidenceRoute(for: citationToken, user: owner)
        precondition(missingRoute == nil)
        precondition(groundedModel.transcript.isEmpty)
        precondition(groundedModel.draft.isEmpty)
        precondition(businessResetCount >= 1)

        let failureModel = AssistantModel(
            loadCapability: { enabled },
            reasoning: reasoning,
            businessReasoning: AssistantBusinessReasoningOperations(
                respond: { _, _, _ in throw SmokeFailure.groundedToolFailed },
                evidenceRoute: { _, _ in nil },
                releaseEvidence: { _ in },
                reset: {}
            )
        )
        failureModel.draft = "show analytics"
        let failureText = await failureModel.submit(
            callIsActive: false, user: owner, currentOSMajor: 26
        )
        precondition(failureText == AssistantGroundedResponse.unverified.text)
        precondition(failureText?.rangeOfCharacter(from: .decimalDigits) == nil)
        precondition(failureText?.rangeOfCharacter(
            from: CharacterSet(charactersIn: "$£€¥")
        ) == nil)

        let gate = DelayedGreetingGate()
        var resetCount = 0
        let delayedModel = AssistantModel(
            loadCapability: { enabled },
            reasoning: AssistantReasoningOperations(
                availability: { .available },
                prewarm: {},
                respond: { _ in await gate.response() },
                reset: { resetCount += 1 }
            )
        )
        delayedModel.draft = "Hello"
        let delayedSubmit = Task { @MainActor in
            await delayedModel.submit(callIsActive: false, currentOSMajor: 26)
        }
        await gate.waitUntilStarted()

        delayedModel.noteCallActivity(true)
        precondition(resetCount == 1)
        precondition(delayedModel.draft.isEmpty)
        precondition(delayedModel.transcript.isEmpty)
        precondition(delayedModel.phase == .interruptedByCall)

        await gate.release()
        let lateResponse = await delayedSubmit.value
        precondition(lateResponse == nil, "cancelled response escaped to optional speech output")
        precondition(delayedModel.transcript.isEmpty, "late response reached the transcript")
        precondition(delayedModel.phase == .interruptedByCall)

        print("Assistant model smoke: OK")
    }
}
