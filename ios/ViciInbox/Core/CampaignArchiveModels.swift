import Foundation

/// The archived flag for campaigns, read alongside the campaign list.
///
/// Kept separate from `CampaignRecord` on purpose, for now. The archive API is
/// being built by another agent and `archived_at` is not yet a column this
/// client can rely on; decoding it as a parallel, fully optional projection of
/// the same payload means a backend that has never heard of archiving returns
/// an empty map and the list behaves exactly as it does today. When the field
/// lands for real this collapses into one optional property on
/// `CampaignRecord` and this file goes away.
struct CampaignArchiveState: Decodable, Hashable {
    let id: String
    let archivedAt: String?

    private enum CodingKeys: String, CodingKey {
        case id
        case archivedAt = "archived_at"
        case archivedAtCamel = "archivedAt"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let value = try? container.decode(String.self, forKey: .id) {
            id = value
        } else if let value = try? container.decode(Int.self, forKey: .id) {
            id = String(value)
        } else {
            id = ""
        }
        let snake = try? container.decodeIfPresent(String.self, forKey: .archivedAt)
        let camel = try? container.decodeIfPresent(String.self, forKey: .archivedAtCamel)
        let raw = (snake ?? nil) ?? (camel ?? nil)
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines)
        archivedAt = (trimmed?.isEmpty ?? true) ? nil : trimmed
    }
}

/// Just enough of the campaign list envelope to pull the archive flags out of
/// it without re-describing every campaign field.
struct CampaignArchiveStatePage: Decodable {
    let items: [CampaignArchiveState]
}

/// A campaign page together with the archived timestamps for its items.
struct CampaignListResult {
    let page: CampaignPage
    /// Campaign id -> archived timestamp. Absent means not archived.
    let archivedAt: [String: String]
}
