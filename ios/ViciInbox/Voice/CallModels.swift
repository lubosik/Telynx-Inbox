import Foundation

/// UI-facing state of a call. Deliberately decoupled from the Telnyx SDK's own
/// enum so the views don't break when the SDK changes.
enum CallPhase: String {
    case idle
    case ringing        // inbound, not yet answered
    case connecting     // outbound dialling, or answered and negotiating media
    case active
    case held
    case ended
}

/// A single call as the UI sees it.
struct ActiveCall: Identifiable, Equatable {
    /// UUID shared with CallKit. For inbound push calls this is the call ID
    /// carried in the VoIP push payload — CallKit and the SDK must agree on
    /// it or answering does nothing.
    let id: UUID
    var callerName: String
    var callerNumber: String
    var isInbound: Bool
    var phase: CallPhase
    var isMuted: Bool = false
    var isOnHold: Bool = false
    var isOnSpeaker: Bool = false
    var startedAt: Date?
    var connectedAt: Date?

    var displayTitle: String {
        if !callerName.isEmpty && callerName != callerNumber { return callerName }
        return PhoneFormatter.pretty(callerNumber)
    }

    var durationSeconds: Int {
        guard let connectedAt else { return 0 }
        return max(0, Int(Date().timeIntervalSince(connectedAt)))
    }
}

/// Mirrors the phone normalisation the backend already does, so numbers shown
/// in the app match what the web inbox shows.
enum PhoneFormatter {

    /// Best-effort E.164 for dialling (US default, matching the backend).
    static func e164(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        if raw.hasPrefix("+") { return "+" + digits }
        if digits.count == 10 { return "+1" + digits }
        if digits.count == 11, digits.hasPrefix("1") { return "+" + digits }
        return digits.isEmpty ? raw : "+" + digits
    }

    /// (305) 555-0123 style for display.
    static func pretty(_ raw: String) -> String {
        let digits = raw.filter(\.isNumber)
        let national: String
        if digits.count == 11, digits.hasPrefix("1") {
            national = String(digits.dropFirst())
        } else if digits.count == 10 {
            national = digits
        } else {
            return raw
        }
        let area = national.prefix(3)
        let mid  = national.dropFirst(3).prefix(3)
        let last = national.suffix(4)
        return "(\(area)) \(mid)-\(last)"
    }
}
