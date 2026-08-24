import Foundation

@main
struct AssistantModelsSmoke {
    static func main() async throws {
        let enabled = try JSONDecoder().decode(
            AssistantCapabilityStatus.self,
            from: Data(#"{"enabled":true,"mode":"on_device_read_only","minimumOSMajor":26,"reason":null}"#.utf8)
        )
        precondition(enabled.enabled)
        precondition(enabled.mode == AssistantCapabilityStatus.supportedMode)

        let owner = try user(role: "owner", permissions: ["assistant.use"])
        let admin = try user(role: "ADMIN", permissions: ["assistant.use"])
        let agent = try user(role: "agent", permissions: ["assistant.use"])
        let shared = try user(role: "admin", permissions: ["assistant.use"], isLegacyShared: true)
        let missingPermissionDocument = try user(role: "admin", permissions: nil)
        precondition(AssistantAccess.isPermitted(for: owner))
        precondition(AssistantAccess.isPermitted(for: admin))
        precondition(!AssistantAccess.isPermitted(for: agent))
        precondition(!AssistantAccess.isPermitted(for: shared))
        precondition(!AssistantAccess.isPermitted(for: missingPermissionDocument))
        precondition(!AssistantAccess.isPermitted(for: nil))
        precondition(AssistantInputPolicy.maximumCharacters == 500)
        precondition(AssistantOutputPolicy.maximumCharacters == 1_500)
        precondition(AssistantOutputPolicy.sanitise("  Hello\u{2014}there  ") == "Hello-there")
        precondition(AssistantGreetingOutputPolicy.validatedGreeting("Hello! How can I help?") == "Hello! How can I help?")
        precondition(AssistantGreetingOutputPolicy.validatedGreeting("Vici revenue is $999,999") == "Hello.")
        precondition(AssistantGreetingOutputPolicy.validatedGreeting("Hello, sales are strong") == "Hello.")
        precondition(AssistantGreetingOutputPolicy.validatedGreeting("Hello, Lubosi is here") == "Hello.")
        precondition(AssistantGreetingOutputPolicy.validatedGreeting("The answer is nine") == "Hello.")
        precondition(AssistantPromptCatalog.current.id == "vici-assistant-reasoner-v1.0-ios26")
        precondition(AssistantPromptCatalog.current.contentSHA256 == "4f8fa99788387bf7a1cb994c7c9c32b480aeb7cab606c48fc8780a65a887d6fe")
        precondition(!AssistantPromptCatalog.current.instructions.contains("userInput"))

        var generatorCalls = 0
        let denied = try await AssistantReasoningScope.answer(
            to: "How much revenue did Vici make today?"
        ) { _ in
            generatorCalls += 1
            return "Vici made $999,999 today"
        }
        precondition(generatorCalls == 0, "business questions must never reach the no-tools model")
        precondition(!denied.wasGenerated)
        precondition(denied.text == AssistantReasoningScope.unavailableDataMessage)
        precondition(!denied.text.contains("999,999"))

        let shellAnswer = try await AssistantReasoningScope.answer(to: "What can you do?") { _ in
            generatorCalls += 1
            return "Unexpected generated capability claim"
        }
        precondition(generatorCalls == 0)
        precondition(!shellAnswer.wasGenerated)
        precondition(shellAnswer.text.contains("cannot access Vici business data"))

        let allowed = try await AssistantReasoningScope.answer(to: "Hello!") { _ in
            generatorCalls += 1
            return "Hello."
        }
        precondition(generatorCalls == 1)
        precondition(allowed.wasGenerated)
        precondition(allowed.text == "Hello.")

        var machine = AssistantStateMachine()
        precondition(machine.phase == .checkingCapability)
        precondition(machine.resolveCapability(enabled, currentOSMajor: 26))
        precondition(machine.phase == .idle)
        precondition(machine.resolveReasoningAvailability(.available, currentOSMajor: 26))
        precondition(machine.phase == .idle)
        precondition(machine.beginThinking())
        precondition(machine.phase == .thinking)
        precondition(machine.beginSpeaking())
        precondition(machine.phase == .speaking)
        precondition(machine.finishResponse())
        precondition(machine.phase == .idle)
        precondition(!machine.finishResponse(), "illegal transitions must be refused")

        machine.beginCapabilityCheck(callIsActive: false)
        precondition(machine.resolveCapability(enabled, currentOSMajor: 26))
        precondition(machine.resolveReasoningAvailability(.modelNotReady, currentOSMajor: 26))
        precondition(machine.phase == .unavailable(.modelNotReady))

        machine.beginCapabilityCheck(callIsActive: false)
        precondition(machine.resolveCapability(enabled, currentOSMajor: 25))
        precondition(machine.phase == .unavailable(.requiresNewerOS(required: 26, current: 25)))

        let wrongMode = AssistantCapabilityStatus(
            enabled: true,
            mode: "cloud",
            minimumOSMajor: 16,
            reason: nil
        )
        machine.beginCapabilityCheck(callIsActive: false)
        precondition(machine.resolveCapability(wrongMode, currentOSMajor: 26))
        precondition(machine.phase == .unavailable(.unsupportedMode))

        let disabled = AssistantCapabilityStatus(
            enabled: false,
            mode: AssistantCapabilityStatus.supportedMode,
            minimumOSMajor: 26,
            reason: "pilot_disabled"
        )
        machine.beginCapabilityCheck(callIsActive: false)
        precondition(machine.resolveCapability(disabled, currentOSMajor: 26))
        precondition(machine.phase == .disabled)

        machine.interruptForCall()
        precondition(machine.phase == .interruptedByCall)
        precondition(machine.finishCallInterruption())
        precondition(machine.phase == .checkingCapability)
        precondition(machine.fail())
        precondition(machine.phase == .failed)

        let entry = AssistantTranscriptEntry(role: .assistant, text: "Not installed")
        precondition(entry.role == .assistant)
        precondition(entry.text == "Not installed")

        print("Assistant models smoke: OK")
    }

    private static func user(role: String,
                             permissions: [String]?,
                             isLegacyShared: Bool = false) throws -> AuthUser {
        var object: [String: Any] = [
            "id": "user-1",
            "displayName": "Named User",
            "email": "named@example.com",
            "role": role,
            "isLegacyShared": isLegacyShared,
            "viaLegacySession": false
        ]
        if let permissions { object["permissions"] = permissions }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(AuthUser.self, from: data)
    }
}
