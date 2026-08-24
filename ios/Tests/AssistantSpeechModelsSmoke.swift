import Foundation

@main
struct AssistantSpeechModelsSmoke {
    static func main() {
        var unavailable = AssistantSpeechStateMachine(supportsSpeechAnalyzer: false)
        precondition(unavailable.phase == .unavailable(.requiresIOS26))
        precondition(!unavailable.pressBegan())

        var machine = AssistantSpeechStateMachine(supportsSpeechAnalyzer: true)
        precondition(machine.phase == .readyToRequest)
        precondition(machine.pressBegan())
        precondition(machine.phase == .requestingMicrophonePermission)
        precondition(machine.resolveMicrophonePermission(granted: false))
        precondition(machine.phase == .microphoneDenied)
        precondition(machine.pressBegan(), "permission can be rechecked after Settings changes")
        precondition(machine.resolveMicrophonePermission(granted: true))
        precondition(machine.phase == .checkingAssets)
        precondition(machine.beginAssetDownload())
        precondition(machine.phase == .downloadingAssets)
        precondition(machine.assetsReady(pressIsHeld: false))
        precondition(machine.phase == .ready, "release during download must not begin listening")

        precondition(machine.pressBegan())
        precondition(machine.resolveMicrophonePermission(granted: true))
        precondition(machine.assetsReady(pressIsHeld: true))
        precondition(machine.phase == .listening)
        precondition(machine.pressEnded())
        precondition(machine.phase == .finalizing)
        precondition(machine.finishTranscription())
        precondition(machine.phase == .ready)

        machine.interruptForCall()
        precondition(machine.phase == .interruptedByCall)
        precondition(machine.callEnded())
        precondition(machine.phase == .readyToRequest)

        let candidates = [
            AssistantVoiceCandidate(identifier: "en-gb-standard", language: "en-GB", quality: .standard),
            AssistantVoiceCandidate(identifier: "en-gb-enhanced-b", language: "en_GB", quality: .enhanced),
            AssistantVoiceCandidate(identifier: "en-gb-enhanced-a", language: "en-GB", quality: .enhanced),
            AssistantVoiceCandidate(identifier: "en-us-premium", language: "en-US", quality: .premium),
            AssistantVoiceCandidate(identifier: "fr-premium", language: "fr-FR", quality: .premium)
        ]

        // An exact locale match wins before quality in a different locale.
        precondition(AssistantVoiceSelector.select(
            from: candidates,
            localeIdentifier: "en-GB",
            storedIdentifier: nil
        )?.identifier == "en-gb-enhanced-a")

        // Stored preference is only a tie-breaker at the best installed quality.
        precondition(AssistantVoiceSelector.select(
            from: candidates,
            localeIdentifier: "en_GB",
            storedIdentifier: "en-gb-enhanced-b"
        )?.identifier == "en-gb-enhanced-b")
        precondition(AssistantVoiceSelector.select(
            from: candidates,
            localeIdentifier: "en-CA",
            storedIdentifier: "en-gb-standard"
        )?.identifier == "en-us-premium")
        precondition(AssistantVoiceSelector.select(
            from: candidates,
            localeIdentifier: "de-DE",
            storedIdentifier: nil
        ) == nil)

        print("Assistant speech models smoke: OK")
    }
}
