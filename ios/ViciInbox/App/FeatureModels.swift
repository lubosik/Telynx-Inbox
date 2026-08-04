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
            await MessageNotificationManager.shared.updateAppBadge(count: unreadTotal)
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
            for original in imageData.prefix(4) {
                guard let image = UIImage(data: original),
                      let compressed = Self.carrierSafeJPEG(image) else {
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

    private static func carrierSafeJPEG(_ image: UIImage) -> Data? {
        let maximumDimension: CGFloat = 1600
        let scale = min(1, maximumDimension / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * scale), height: max(1, image.size.height * scale))
        let renderer = UIGraphicsImageRenderer(size: size)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        for quality in stride(from: 0.82, through: 0.25, by: -0.1) {
            if let data = resized.jpegData(compressionQuality: quality), data.count <= 900_000 { return data }
        }
        return resized.jpegData(compressionQuality: 0.2)
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
    @Published var errorMessage: String?

    func load() async {
        isLoading = logs.isEmpty
        defer { isLoading = false }
        do { logs = try await APIClient.shared.fetchCallLogs(); errorMessage = nil }
        catch { errorMessage = error.localizedDescription }
    }
}
