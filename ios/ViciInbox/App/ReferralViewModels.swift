import Foundation
import Combine

/// UI affordances mirror the database-owned transition rules. The API remains
/// authoritative and may still refuse an action if state changed concurrently.
struct ReferralActionAvailability: Equatable {
    let canClaim: Bool
    let canReassign: Bool
    let canHandBack: Bool
    let canResolve: Bool

    static func resolve(referral: ReferralRecord,
                        currentUser: AuthUser?,
                        canAct: Bool) -> ReferralActionAvailability {
        guard let user = currentUser,
              !user.isSharedTeamLogin,
              canAct else {
            return ReferralActionAvailability(canClaim: false,
                                              canReassign: false,
                                              canHandBack: false,
                                              canResolve: false)
        }
        let adminish = RoleCatalog.isAdminish(user.role)
        let isOwner = referral.owner?.id == user.id
        let isReferrer = referral.referredBy?.id == user.id
        let isDirectedTarget = referral.originalTarget?.id == user.id
        let canClaim = referral.state == .pending && !isReferrer &&
            ((referral.targetKind == .directed && isDirectedTarget) ||
             (referral.targetKind == .anyAdmin && adminish))
        let canManageOwned = referral.state == .owned && (isOwner || adminish)
        return ReferralActionAvailability(
            canClaim: canClaim,
            canReassign: canManageOwned,
            canHandBack: canManageOwned && referral.owner?.id != referral.referredBy?.id,
            canResolve: referral.state != .resolved && (isOwner || adminish)
        )
    }
}

@MainActor
final class ReferralsModel: ObservableObject {
    @Published private(set) var items: [ReferralRecord] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    func load(box: ReferralBox) async {
        isLoading = items.isEmpty
        defer { isLoading = false }
        do {
            items = try await APIClient.shared.fetchReferrals(box: box)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
final class ReferralDetailModel: ObservableObject {
    @Published private(set) var detail: ReferralDetailResponse?
    @Published private(set) var recipients: ReferralRecipientsResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var isActing = false
    @Published var errorMessage: String?

    let id: String

    init(id: String) { self.id = id }

    func load() async {
        isLoading = detail == nil
        defer { isLoading = false }
        do {
            async let loadedDetail = APIClient.shared.fetchReferral(id: id)
            async let loadedRecipients = APIClient.shared.fetchReferralRecipients()
            detail = try await loadedDetail
            recipients = try? await loadedRecipients
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func claim() async { await mutate { try await APIClient.shared.claimReferral(id: id) } }

    func resolve() async { await mutate { try await APIClient.shared.resolveReferral(id: id) } }

    func reassign(to userID: String, note: String) async {
        await mutate { try await APIClient.shared.reassignReferral(id: id, targetUserID: userID, note: note) }
    }

    func handBack(note: String) async {
        await mutate { try await APIClient.shared.handBackReferral(id: id, note: note) }
    }

    private func mutate(_ operation: () async throws -> ReferralRecord) async {
        isActing = true
        defer { isActing = false }
        do {
            _ = try await operation()
            detail = try await APIClient.shared.fetchReferral(id: id)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

@MainActor
final class ReferralComposerModel: ObservableObject {
    @Published var draft = ReferralComposerDraft()
    @Published private(set) var recipients: ReferralRecipientsResponse?
    @Published private(set) var isLoading = false
    @Published private(set) var isSubmitting = false
    @Published var errorMessage: String?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            recipients = try await APIClient.shared.fetchReferralRecipients()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func submit(phone: String) async -> ReferralRecord? {
        guard let recipient = draft.recipient, draft.canSubmit else { return nil }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            let referral = try await APIClient.shared.createReferral(
                contactPhone: phone,
                recipient: recipient,
                note: draft.trimmedNote
            )
            errorMessage = nil
            return referral
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
