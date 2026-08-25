import Foundation
import LocalAuthentication

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

// MARK: - What the operator chose

/// Which voice to speak with.
///
/// `automatic` is the existing behaviour: the best installed voice for this
/// device's locale, re-evaluated each time, so installing a Premium voice
/// improves it without anybody touching a setting.
///
/// `pinned` is a deliberate choice and is honoured ABSOLUTELY while that voice
/// is still installed. `AssistantVoiceSelector.select` treats a stored
/// identifier only as a tie-break at the best quality, which is right for a
/// remembered automatic pick and wrong for a person who listened to four voices
/// and chose one. A setting that silently loses to a quality score is a setting
/// that lies.
enum AssistantVoicePreference: Equatable {
    case automatic
    case pinned(identifier: String)

    var pinnedIdentifier: String? {
        if case .pinned(let identifier) = self { return identifier }
        return nil
    }
}

extension AssistantVoiceSelector {
    /// Resolves a preference against what is actually installed right now.
    ///
    /// A pinned voice that has been deleted from the device falls back to
    /// automatic rather than going silent. Losing a voice must not lose the
    /// assistant.
    static func resolve(preference: AssistantVoicePreference,
                        candidates: [AssistantVoiceCandidate],
                        localeIdentifier: String,
                        storedIdentifier: String?) -> AssistantVoiceCandidate? {
        if let pinned = preference.pinnedIdentifier,
           let match = candidates.first(where: { $0.identifier == pinned }) {
            return match
        }
        return select(from: candidates,
                      localeIdentifier: localeIdentifier,
                      storedIdentifier: storedIdentifier)
    }
}

/// How fast the assistant speaks. Three named steps rather than a raw slider,
/// because `AVSpeechUtterance` rate is not a scale anybody can reason about and
/// a mis-set slider makes the product feel broken.
enum AssistantSpeakingRate: String, CaseIterable, Identifiable {
    case slow, normal, fast

    var id: String { rawValue }

    var label: String {
        switch self {
        case .slow: return "Slower"
        case .normal: return "Normal"
        case .fast: return "Faster"
        }
    }

    /// Multipliers of `AVSpeechUtteranceDefaultSpeechRate`, kept deliberately
    /// gentle. Anything past about 1.2 stops sounding like a person.
    var multiplier: Float {
        switch self {
        case .slow: return 0.85
        case .normal: return 1.0
        case .fast: return 1.15
        }
    }
}

/// The orb's accent. A closed set, not a colour wheel: every option has to stay
/// legible on both light and dark backgrounds and has to keep the state colours
/// distinguishable, and a free picker guarantees somebody eventually chooses a
/// tint that hides the failure state.
enum AssistantOrbTint: String, CaseIterable, Identifiable {
    case brand, indigo, teal, amber, rose, graphite

    var id: String { rawValue }

    var label: String {
        switch self {
        case .brand: return "Vici"
        case .indigo: return "Indigo"
        case .teal: return "Teal"
        case .amber: return "Amber"
        case .rose: return "Rose"
        case .graphite: return "Graphite"
        }
    }
}

/// How large the orb is drawn.
enum AssistantOrbSize: String, CaseIterable, Identifiable {
    case compact, standard, large

    var id: String { rawValue }

    var label: String {
        switch self {
        case .compact: return "Compact"
        case .standard: return "Standard"
        case .large: return "Large"
        }
    }

    var diameter: CGFloat {
        switch self {
        case .compact: return 128
        case .standard: return 168
        case .large: return 208
        }
    }
}

// MARK: - Confirming with Face ID

/// A deliberate confirmation for the few actions that are hard to undo.
///
/// WHAT THIS IS, AND WHAT IT IS NOT
///   It is not authentication. The person is already signed in and the server
///   has already decided what they may do. This is a second, physical act
///   between an intention and an irreversible outcome, for the two places where
///   a mis-tap is expensive: putting somebody back into every future campaign,
///   and sending real messages to real customers.
///
/// IT MUST NOT BECOME A LOCKED DOOR
///   `deviceOwnerAuthentication` falls back to the passcode on its own when
///   Face ID is unavailable, not enrolled, or locked out after failures. And if
///   the device has no passcode at all, this returns `.unavailable` and the
///   caller proceeds with its ordinary confirmation rather than refusing. A
///   phone with no passcode is not a reason somebody cannot run their business,
///   and it is the owner's device either way.
enum BiometricConfirmation {
    enum Outcome: Equatable {
        /// The person confirmed with Face ID, Touch ID, or the device passcode.
        case confirmed
        /// They cancelled, or failed. The action must not proceed.
        case declined
        /// The device cannot ask. The caller falls back to a normal confirmation.
        case unavailable
    }

    /// - Parameter reason: shown by the system inside the Face ID prompt. It is
    ///   read at the moment of deciding, so it names the ACTION and its
    ///   consequence, not the app.
    static func confirm(reason: String) async -> Outcome {
        let context = LAContext()
        // Nothing else in the app should be able to reuse a recent unlock to
        // satisfy this. Every high-impact action asks again.
        context.touchIDAuthenticationAllowableReuseDuration = 0
        context.localizedCancelTitle = "Cancel"

        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return .unavailable
        }
        do {
            let approved = try await context.evaluatePolicy(.deviceOwnerAuthentication,
                                                            localizedReason: reason)
            return approved ? .confirmed : .declined
        } catch {
            // Cancellation and failure are the same outcome here: the action
            // does not happen. They are deliberately not distinguished, because
            // treating a failure as "try again quietly" is how a confirmation
            // becomes a formality.
            return .declined
        }
    }
}
