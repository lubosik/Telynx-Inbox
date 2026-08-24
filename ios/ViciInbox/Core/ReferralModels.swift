import Foundation

/// Foundation-only contracts for the internal conversation referral API.
///
/// A referral note is internal context. It is never an SMS body and these
/// models intentionally have no dependency on message sending types.
enum ReferralTargetKind: String, Codable, Hashable {
    case directed
    case anyAdmin = "any_admin"
}

enum ReferralState: String, Codable, Hashable {
    case pending
    case owned
    case resolved
}

enum ReferralBox: String, CaseIterable, Identifiable {
    case received
    case sent

    var id: String { rawValue }
    var title: String { rawValue.capitalized }
}

struct ReferralUser: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let role: String?
}

struct ReferralRecipient: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let role: String?
    let lastSeenAt: String?
    let canReceiveAnyAdmin: Bool
}

struct ReferralRecord: Decodable, Identifiable, Hashable {
    let id: String
    let contactPhone: String
    let contactName: String
    let referredBy: ReferralUser?
    let targetKind: ReferralTargetKind
    let originalTarget: ReferralUser?
    let owner: ReferralUser?
    let state: ReferralState
    let initialNote: String?
    let claimedAt: String?
    let resolvedAt: String?
    let resolvedBy: ReferralUser?
    let createdAt: String
    let updatedAt: String
    let version: Int
    let attentionRequired: Bool

    var recipientLabel: String {
        if targetKind == .anyAdmin && originalTarget == nil { return "Any Admin" }
        return originalTarget?.name ?? "Named teammate"
    }
}

struct ReferralEvent: Decodable, Identifiable, Hashable {
    let id: String
    let action: String
    let actor: ReferralUser?
    let from: ReferralUser?
    let to: ReferralUser?
    let note: String?
    let occurredAt: String
}

struct ReferralRecipientsResponse: Decodable, Hashable {
    let recipients: [ReferralRecipient]
    let anyAdminAvailable: Bool
}

struct ReferralListResponse: Decodable, Hashable {
    let items: [ReferralRecord]
}

struct ReferralDetailResponse: Decodable, Hashable {
    let referral: ReferralRecord
    let events: [ReferralEvent]
}

struct ReferralMutationResponse: Decodable, Hashable {
    let referral: ReferralRecord
}

/// Pure state owned by the referral sheet. Keeping it out of
/// `MessageThreadView.draft` is a hard boundary: dismissing or submitting a
/// referral cannot alter the customer-visible composer.
struct ReferralComposerDraft: Equatable {
    enum Recipient: Equatable {
        case teammate(id: String)
        case anyAdmin
    }

    var recipient: Recipient?
    var note = ""

    var trimmedNote: String {
        note.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var canSubmit: Bool { recipient != nil && note.count <= 1_000 }
}
