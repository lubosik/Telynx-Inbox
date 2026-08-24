import Foundation

enum AssistantSpeechUnavailableReason: Equatable {
    case requiresIOS26
    case hardwareUnsupported
    case localeUnsupported
}

/// Speech has its own state because microphone and asset availability must
/// never be confused with the server capability or future reasoning state.
enum AssistantSpeechPhase: Equatable {
    case readyToRequest
    case requestingMicrophonePermission
    case microphoneDenied
    case checkingAssets
    case downloadingAssets
    case ready
    case listening
    case finalizing
    case interruptedByCall
    case unavailable(AssistantSpeechUnavailableReason)
    case failed
}

/// Foundation-only transition rules for point-of-use, push-to-talk capture.
struct AssistantSpeechStateMachine: Equatable {
    private(set) var phase: AssistantSpeechPhase

    init(supportsSpeechAnalyzer: Bool) {
        phase = supportsSpeechAnalyzer ? .readyToRequest : .unavailable(.requiresIOS26)
    }

    @discardableResult
    mutating func pressBegan() -> Bool {
        switch phase {
        case .readyToRequest, .ready, .microphoneDenied, .failed:
            phase = .requestingMicrophonePermission
            return true
        default:
            return false
        }
    }

    @discardableResult
    mutating func resolveMicrophonePermission(granted: Bool) -> Bool {
        guard phase == .requestingMicrophonePermission else { return false }
        phase = granted ? .checkingAssets : .microphoneDenied
        return true
    }

    @discardableResult
    mutating func beginAssetDownload() -> Bool {
        guard phase == .checkingAssets else { return false }
        phase = .downloadingAssets
        return true
    }

    @discardableResult
    mutating func assetsReady(pressIsHeld: Bool) -> Bool {
        guard phase == .checkingAssets || phase == .downloadingAssets else { return false }
        phase = pressIsHeld ? .listening : .ready
        return true
    }

    @discardableResult
    mutating func pressEnded() -> Bool {
        guard phase == .listening else { return false }
        phase = .finalizing
        return true
    }

    @discardableResult
    mutating func finishTranscription() -> Bool {
        guard phase == .finalizing else { return false }
        phase = .ready
        return true
    }

    mutating func makeUnavailable(_ reason: AssistantSpeechUnavailableReason) {
        phase = .unavailable(reason)
    }

    mutating func fail() {
        phase = .failed
    }

    mutating func interruptForCall() {
        phase = .interruptedByCall
    }

    @discardableResult
    mutating func callEnded() -> Bool {
        guard phase == .interruptedByCall else { return false }
        phase = .readyToRequest
        return true
    }
}

enum AssistantVoiceQuality: Int, Comparable, Equatable {
    case standard = 0
    case enhanced = 1
    case premium = 2

    static func < (lhs: AssistantVoiceQuality, rhs: AssistantVoiceQuality) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}

struct AssistantVoiceCandidate: Equatable {
    let identifier: String
    let language: String
    let quality: AssistantVoiceQuality
}

/// Selects only an installed locale-compatible voice. Exact locale beats a
/// language-only match; then premium beats enhanced, which beats standard.
/// A previously stored identifier only resolves a tie at the best quality, so
/// installing a better voice can improve the next selection automatically.
enum AssistantVoiceSelector {
    static func select(from candidates: [AssistantVoiceCandidate],
                       localeIdentifier: String,
                       storedIdentifier: String?) -> AssistantVoiceCandidate? {
        let requested = normalise(localeIdentifier)
        let language = languageCode(requested)
        let exact = candidates.filter { normalise($0.language) == requested }
        let sameLanguage = candidates.filter { languageCode(normalise($0.language)) == language }
        let pool = exact.isEmpty ? sameLanguage : exact
        guard let bestQuality = pool.map(\.quality).max() else { return nil }
        let best = pool.filter { $0.quality == bestQuality }
        if let storedIdentifier,
           let stored = best.first(where: { $0.identifier == storedIdentifier }) {
            return stored
        }
        return best.sorted { $0.identifier < $1.identifier }.first
    }

    private static func normalise(_ identifier: String) -> String {
        identifier.replacingOccurrences(of: "_", with: "-").lowercased()
    }

    private static func languageCode(_ identifier: String) -> String {
        String(identifier.split(separator: "-").first ?? Substring(identifier))
    }
}
