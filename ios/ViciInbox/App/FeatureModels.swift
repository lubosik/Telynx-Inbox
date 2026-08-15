import Foundation
import UIKit

@MainActor
final class InboxModel: ObservableObject {
    @Published private(set) var conversations: [ConversationSummary] = []
    @Published private(set) var messages: [String: [MessageRecord]] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published var errorMessage: String?
    private var refreshInProgress = false
    private var threadRefreshes: Set<String> = []

    var unreadTotal: Int {
        conversations.reduce(0) { total, conversation in
            total + max(0, conversation.unreadCount ?? 0)
        }
    }

    func load() async {
        guard !refreshInProgress else { return }
        refreshInProgress = true
        isLoading = conversations.isEmpty
        defer { isLoading = false; refreshInProgress = false }
        do {
            let loaded = try await APIClient.shared.fetchConversations()
            if loaded != conversations { conversations = loaded }
            await MessageNotificationManager.shared.setUnreadMessages(unreadTotal)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadThread(phone: String) async {
        guard !threadRefreshes.contains(phone) else { return }
        threadRefreshes.insert(phone)
        defer { threadRefreshes.remove(phone) }
        do {
            let loaded = try await APIClient.shared.fetchThread(phone: phone)
            if messages[phone] != loaded { messages[phone] = loaded }
            if let index = conversations.firstIndex(where: { $0.phone == phone }),
               (conversations[index].unreadCount ?? 0) > 0 {
                await load()
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func send(text: String, imageData: [Data], to phone: String,
              replyingTo message: MessageRecord?) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !imageData.isEmpty else { return false }
        isSending = true
        defer { isSending = false }
        do {
            var urls: [String] = []
            let selectedImages = Array(imageData.prefix(4))
            // Telnyx accepts more at the API boundary, but recommends staying
            // under 600 KB total for universal carrier compatibility. Keep a
            // little transport/transcoding headroom and divide that budget
            // across the complete selection instead of compressing each image
            // independently.
            let bytesPerImage = max(100_000, 580_000 / max(1, selectedImages.count))
            for original in selectedImages {
                guard let image = UIImage(data: original),
                      let compressed = Self.carrierSafeJPEG(image, maximumBytes: bytesPerImage) else {
                    throw APIError.server("One of the selected images could not be prepared.")
                }
                urls.append(try await APIClient.shared.uploadJPEG(compressed))
            }
            try await APIClient.shared.sendMessage(
                to: phone,
                message: trimmed,
                mediaURLs: urls,
                replyToMessageID: message?.numericID
            )
            await loadThread(phone: phone)
            await load()
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func react(to message: MessageRecord, type: String, phone: String) async {
        guard let id = message.numericID else { return }
        do {
            try await APIClient.shared.react(to: id, type: type)
            await loadThread(phone: phone)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private static func carrierSafeJPEG(_ image: UIImage, maximumBytes: Int) -> Data? {
        guard image.size.width > 0, image.size.height > 0, maximumBytes > 0 else { return nil }

        var longestEdge: CGFloat = 1_600
        while longestEdge >= 480 {
            let scale = min(1, longestEdge / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, image.size.width * scale),
                              height: max(1, image.size.height * scale))
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            format.opaque = true
            let renderer = UIGraphicsImageRenderer(size: size, format: format)
            let resized = renderer.image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
            }
            for quality in stride(from: 0.82, through: 0.18, by: -0.08) {
                if let data = resized.jpegData(compressionQuality: quality), data.count <= maximumBytes {
                    return data
                }
            }
            longestEdge *= 0.75
        }
        return nil
    }
}

@MainActor
final class ContactsModel: ObservableObject {
    @Published private(set) var contacts: [ConversationSummary] = []
    @Published private(set) var detail: ContactDetailResponse?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    func load(search: String = "") async {
        isLoading = contacts.isEmpty
        defer { isLoading = false }
        do {
            contacts = try await APIClient.shared.fetchAllContacts(search: search)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func loadDetail(phone: String) async {
        isLoading = true
        defer { isLoading = false }
        do {
            detail = try await APIClient.shared.fetchContact(phone: phone)
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func create(firstName: String, lastName: String, phone: String,
                email: String, notes: String) async -> Bool {
        do {
            _ = try await APIClient.shared.createContact(firstName: firstName, lastName: lastName,
                                                         phone: phone, email: email, notes: notes)
            await load()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    func update(_ contact: ConversationSummary, firstName: String, lastName: String,
                email: String, notes: String) async -> Bool {
        do {
            _ = try await APIClient.shared.updateContact(phone: contact.phone, firstName: firstName,
                                                         lastName: lastName, email: email, notes: notes)
            await loadDetail(phone: contact.phone)
            await load()
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }
}

@MainActor
final class ActivityModel: ObservableObject {
    @Published private(set) var stats: ActivityStats?
    @Published private(set) var queue: [ActivityRecord] = []
    @Published private(set) var recent: [ActivityRecord] = []
    @Published private(set) var isLoading = false
    @Published var flow = "all"
    @Published var errorMessage: String?
    /// Set while a cancel is in flight so the row can show progress and the
    /// button cannot be tapped twice.
    @Published private(set) var cancellingID: String?

    func load() async {
        isLoading = stats == nil
        defer { isLoading = false }
        do {
            async let newStats = APIClient.shared.fetchActivityStats()
            async let newQueue = APIClient.shared.fetchActivityQueue(flow: flow)
            async let newRecent = APIClient.shared.fetchRecentActivity(flow: flow)
            let values = try await (newStats, newQueue, newRecent)
            stats = values.0
            queue = values.1.items
            recent = values.2.items
            errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }

    func cancel(_ item: ActivityRecord) async {
        guard cancellingID == nil else { return }
        cancellingID = item.id
        defer { cancellingID = nil }
        do {
            try await APIClient.shared.cancelScheduledMessage(id: item.id)
            await load()
        } catch { errorMessage = error.localizedDescription }
    }
}

@MainActor
final class CallHistoryModel: ObservableObject {
    @Published private(set) var logs: [CallLogRecord] = []
    @Published private(set) var isLoading = false
    /// Drives the red count on the Calls tab.
    @Published private(set) var unseenMissed = 0
    @Published var errorMessage: String?

    /// Missed calls this device has already shown in history.
    ///
    /// The server tracks the same thing in `call_logs.seen_at`, which is what
    /// keeps the Home Screen badge correct on a message push. This local copy
    /// exists so the badge still clears on a database that has not had
    /// scripts/missed-calls-seen-migration.sql applied, and when the request to
    /// mark them fails. Ids are used rather than a timestamp so there is no
    /// dependence on the device clock agreeing with the server's.
    private let seenIDsKey = "vici.calls.seen-missed-ids"
    /// History returns 50 rows a page, so this cannot drop an id still on screen.
    private let seenIDLimit = 300
    private let didSeedKey = "vici.calls.seeded-existing-history"

    private var seenIDs: [String] {
        get { UserDefaults.standard.stringArray(forKey: seenIDsKey) ?? [] }
        set { UserDefaults.standard.set(newValue.suffix(seenIDLimit).map { $0 }, forKey: seenIDsKey) }
    }

    func load() async {
        isLoading = logs.isEmpty
        defer { isLoading = false }
        do { logs = try await APIClient.shared.fetchCallLogs(); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
        seedExistingHistoryIfNeeded()
        await recount()
    }

    /// Calls that happened before this device ever ran the feature are history,
    /// not a backlog of notifications. Without this the badge would open on a
    /// count of every missed call ever recorded. Mirrors the same one-off
    /// backfill in scripts/missed-calls-seen-migration.sql.
    private func seedExistingHistoryIfNeeded() {
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: didSeedKey) else { return }
        // Only seed once the first response has actually arrived, or a failed
        // load would mark the flag with nothing recorded and let old calls
        // through on the next attempt.
        guard !logs.isEmpty else { return }
        seenIDs = seenIDs + logs.filter(\.isMissedInbound).map(\.id)
        defaults.set(true, forKey: didSeedKey)
    }

    private func recount() async {
        let seen = Set(seenIDs)
        unseenMissed = logs.filter { $0.isMissedInbound && $0.seenAt == nil && !seen.contains($0.id) }.count
        await MessageNotificationManager.shared.setMissedCalls(unseenMissed)
    }

    /// Called when call history is actually on screen. Looking at the list is
    /// what clears the count, the same way WhatsApp behaves — the operator does
    /// not have to open each call.
    func markHistorySeen() async {
        var seen = seenIDs
        let known = Set(seen)
        let newlySeen = logs.filter(\.isMissedInbound).map(\.id).filter { !known.contains($0) }
        if !newlySeen.isEmpty {
            seen.append(contentsOf: newlySeen)
            seenIDs = seen
        }

        // Cleared unconditionally. A call missed while the app was in the
        // background moves the Home Screen badge before its log row is written,
        // so the count can be non-zero with nothing new in the list yet.
        unseenMissed = 0
        await MessageNotificationManager.shared.setMissedCalls(0)
        // Best effort: this keeps the badge attached to message pushes correct
        // and clears the count on the other signed-in device. A failure only
        // means the server copy lags; this device has already recorded it.
        await APIClient.shared.markMissedCallsSeen()
    }
}
