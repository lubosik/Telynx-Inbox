import SwiftUI
import PhotosUI
import UIKit

struct InboxView: View {
    @ObservedObject var model: InboxModel
    @State private var search = ""
    @State private var path: [ConversationSummary] = []
    @State private var pendingNotificationPhone: String?
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    private var filtered: [ConversationSummary] {
        guard !search.isEmpty else { return model.conversations }
        let query = search.lowercased()
        return model.conversations.filter {
            $0.displayName.lowercased().contains(query) ||
            $0.phone.lowercased().contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.isLoading && model.conversations.isEmpty {
                    ProgressView("Loading inbox…")
                } else if filtered.isEmpty {
                    EmptyState(icon: "message", title: "No conversations",
                               detail: search.isEmpty ? "Messages will appear here." : "Try another search.")
                } else {
                    List(filtered) { conversation in
                        NavigationLink(value: conversation) {
                            ConversationRow(conversation: conversation)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await model.load() }
                }
            }
            .navigationTitle("Inbox")
            .navigationDestination(for: ConversationSummary.self) { conversation in
                MessageThreadView(conversation: conversation, model: model)
            }
            .searchable(text: $search, prompt: "Name or phone")
            .task {
                while !Task.isCancelled {
                    await model.load()
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                }
            }
            .alert("Inbox error", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) { Button("OK", role: .cancel) {} } message: { Text(model.errorMessage ?? "Unknown error") }
            .onAppear {
                if let phone = notifications.pendingConversationPhone {
                    pendingNotificationPhone = phone
                    openPendingConversation()
                }
            }
            .onChange(of: notifications.pendingConversationPhone) { phone in
                guard let phone else { return }
                pendingNotificationPhone = phone
                openPendingConversation()
            }
            .onChange(of: notifications.inboxRefreshSequence) { _ in
                Task { await model.load() }
            }
            .onChange(of: scenePhase) { phase in
                guard phase == .active else { return }
                Task { await model.load() }
            }
            .onChange(of: model.conversations) { _ in openPendingConversation() }
        }
    }

    private func openPendingConversation() {
        guard let phone = pendingNotificationPhone,
              let conversation = model.conversations.first(where: { $0.phone == phone }) else { return }
        path = [conversation]
        pendingNotificationPhone = nil
        notifications.consumePendingConversation()
    }
}

private struct ConversationRow: View {
    let conversation: ConversationSummary

    var body: some View {
        HStack(spacing: 12) {
            InitialsAvatar(name: conversation.displayName, imageURL: conversation.avatarURL)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(conversation.displayName).fontWeight((conversation.unreadCount ?? 0) > 0 ? .semibold : .regular)
                    Spacer()
                    if let date = ServerDate.parse(conversation.lastMessage?.createdAt ?? conversation.lastSeen) {
                        Text(date, style: .relative).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 5) {
                    if conversation.lastMessage?.direction == "outbound" {
                        Image(systemName: "arrow.up.right").font(.caption2)
                    }
                    Text(preview)
                        .font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    if let count = conversation.unreadCount, count > 0 {
                        Text(String(count)).font(.caption2.bold()).foregroundColor(.white)
                            .padding(.horizontal, 7).padding(.vertical, 3).background(ViciTheme.tealFill).clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var preview: String {
        if let body = conversation.lastMessage?.body, !body.isEmpty { return body }
        if !(conversation.lastMessage?.mediaURLs ?? []).isEmpty { return "Photo" }
        return conversation.latestOrderStatus.map { "Order: \($0.replacingOccurrences(of: "-", with: " "))" } ?? conversation.phone
    }
}

struct MessageThreadView: View {
    let conversation: ConversationSummary
    @ObservedObject var model: InboxModel
    // Needed for the call button. Supplied at the app root (ViciInboxApp) and
    // inherited through the NavigationLink that pushes this view.
    @EnvironmentObject private var session: SessionModel
    @State private var draft = ""
    @State private var replyTarget: MessageRecord?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var imageData: [Data] = []
    @State private var didInitialScroll = false

    private var messages: [MessageRecord] { model.messages[conversation.phone] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(messages) { message in
                            MessageBubble(message: message) {
                                replyTarget = message
                            } react: { type in
                                Task { await model.react(to: message, type: type, phone: conversation.phone) }
                            }
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal).padding(.vertical, 10)
                }
                .onChange(of: messages.count) { _ in
                    guard let last = messages.last else { return }
                    if didInitialScroll {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    } else {
                        proxy.scrollTo(last.id, anchor: .bottom)
                        didInitialScroll = true
                    }
                }
            }
            Divider()
            if let replyTarget {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Replying to \(replyTarget.isInbound ? conversation.displayName : "your message")")
                            .font(.caption.bold())
                        Text(replyTarget.body ?? "Photo").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    Button { self.replyTarget = nil } label: { Image(systemName: "xmark.circle.fill") }
                }
                .padding(.horizontal).padding(.top, 8)
            }
            if !imageData.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(Array(imageData.enumerated()), id: \.offset) { index, data in
                            if let image = UIImage(data: data) {
                                ZStack(alignment: .topTrailing) {
                                    Image(uiImage: image).resizable().scaledToFill().frame(width: 64, height: 64).clipped().cornerRadius(8)
                                    Button { imageData.remove(at: index) } label: {
                                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                            .foregroundStyle(.white, .black.opacity(0.7))
                                    }.offset(x: 5, y: -5)
                                }
                            }
                        }
                    }.padding(.horizontal).padding(.top, 8)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "photo").font(.title3)
                }
                .disabled(model.isSending)
                TextField("Message", text: $draft, axis: .vertical)
                    .lineLimit(1...5).textFieldStyle(.roundedBorder)
                Button(action: send) {
                    if model.isSending { ProgressView().controlSize(.small) }
                    else { Image(systemName: "arrow.up.circle.fill").font(.title).foregroundColor(ViciTheme.tint) }
                }
                .disabled(model.isSending || (draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && imageData.isEmpty))
            }
            .padding(.horizontal).padding(.vertical, 10)
        }
        .navigationTitle(conversation.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                await model.loadThread(phone: conversation.phone)
                try? await Task.sleep(nanoseconds: 12_000_000_000)
            }
        }
        .onChange(of: pickerItems) { items in
            Task {
                var loaded: [Data] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) { loaded.append(data) }
                }
                imageData = loaded
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                // Place the call through Telnyx, exactly as the Dialer and the
                // call-history rows do.
                //
                // This used to open "tel:" — handing off to the native dialer,
                // which placed an ordinary cellular call from the user's own
                // mobile. The customer saw a personal number instead of the
                // business line, the app never learned the call happened, and
                // nothing was logged. It was also the likeliest button to
                // press, sitting at the top of a customer's conversation.
                Button { session.startOutgoingCall(to: conversation.phone) } label: {
                    Image(systemName: "phone")
                }
                .disabled(!session.isVoiceReady)
            }
        }
    }

    private func send() {
        let text = draft
        let media = imageData
        let reply = replyTarget
        Task {
            if await model.send(text: text, imageData: media, to: conversation.phone, replyingTo: reply) {
                draft = ""; imageData = []; pickerItems = []; replyTarget = nil
            }
        }
    }
}

private struct MessageBubble: View {
    let message: MessageRecord
    let reply: () -> Void
    let react: (String) -> Void
    @State private var isSavingAttachments = false
    @State private var saveNotice: String?

    var body: some View {
        HStack {
            if !message.isInbound { Spacer(minLength: 54) }
            VStack(alignment: message.isInbound ? .leading : .trailing, spacing: 5) {
                ForEach(message.mediaURLs ?? []) { media in
                    if let url = URL(string: media.url) {
                        MessageAttachmentView(url: url)
                    }
                }
                if let body = message.body, !body.isEmpty {
                    Text(body).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(message.isInbound ? ViciTheme.bubbleIn : ViciTheme.bubbleOut)
                        .foregroundColor(message.isInbound ? .primary : .white)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
                HStack(spacing: 5) {
                    if let date = ServerDate.parse(message.createdAt) {
                        Text(date, style: .time).font(.caption2).foregroundStyle(.secondary)
                    }
                    if !message.isInbound, let status = message.status {
                        Text(statusLabel(status)).font(.caption2)
                            .foregroundColor(status.lowercased() == "failed" ? ViciTheme.destructive : Color.secondary)
                            .accessibilityHint(statusHint(status))
                    }
                }
                if let reactions = message.reactions, !reactions.isEmpty {
                    Text(reactions.map { reactionSymbol($0.type) }.joined())
                        .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(.tertiarySystemBackground)).clipShape(Capsule())
                }
            }
            .contextMenu {
                Button("Reply", systemImage: "arrowshape.turn.up.left", action: reply)
                if message.body?.isEmpty == false || !attachmentURLs.isEmpty {
                    Button("Copy", systemImage: "doc.on.doc") { copyMessage() }
                }
                if message.numericID != nil {
                    Menu("React") {
                        ForEach(["loved", "liked", "disliked", "laughed", "emphasized", "questioned"], id: \.self) { type in
                            Button("\(reactionSymbol(type))  \(type.capitalized)") { react(type) }
                        }
                    }
                }
                if !attachmentURLs.isEmpty {
                    Button("Save", systemImage: "square.and.arrow.down") {
                        saveAttachments()
                    }
                    .disabled(isSavingAttachments)
                }
            }
            if message.isInbound { Spacer(minLength: 54) }
        }
        .alert("Image", isPresented: Binding(
            get: { saveNotice != nil },
            set: { if !$0 { saveNotice = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveNotice ?? "")
        }
    }

    private var attachmentURLs: [URL] {
        (message.mediaURLs ?? []).compactMap { URL(string: $0.url) }
    }

    private func saveAttachments() {
        let urls = attachmentURLs
        guard !urls.isEmpty else { return }
        isSavingAttachments = true
        Task {
            var saved = 0
            do {
                for url in urls {
                    try await PhotoLibrarySaver.saveImage(from: url)
                    saved += 1
                }
                saveNotice = saved == 1 ? "Saved to Photos." : "Saved \(saved) images to Photos."
            } catch {
                saveNotice = saved == 0
                    ? error.localizedDescription
                    : "Saved \(saved) image\(saved == 1 ? "" : "s"), but another image could not be saved: \(error.localizedDescription)"
            }
            isSavingAttachments = false
        }
    }

    private func copyMessage() {
        if let body = message.body, !body.isEmpty {
            UIPasteboard.general.string = body
            return
        }
        guard let url = attachmentURLs.first else { return }
        Task {
            do {
                let data = try await PhotoLibrarySaver.imageData(from: url)
                guard let image = UIImage(data: data) else {
                    throw PhotoLibrarySaveError.invalidImage
                }
                UIPasteboard.general.image = image
                saveNotice = "Image copied."
            } catch {
                saveNotice = error.localizedDescription
            }
        }
    }

    private func reactionSymbol(_ type: String) -> String {
        ["loved": "❤️", "liked": "👍", "disliked": "👎", "laughed": "😂", "emphasized": "‼️", "questioned": "❓"][type] ?? "•"
    }

    private func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "queued", "sending": return "Queued"
        case "sent", "delivery_unconfirmed": return "Sent"
        case "delivered": return "Delivered"
        case "failed", "sending_failed", "delivery_failed": return "Failed"
        case "unavailable", "status_unavailable": return "Status unavailable"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    private func statusHint(_ status: String) -> String {
        switch status.lowercased() {
        case "queued", "sending": return "Accepted by Telnyx and waiting to be sent."
        case "sent", "delivery_unconfirmed": return "Sent to the carrier; delivery is not yet confirmed."
        case "delivered": return "Carrier confirmed delivery. SMS does not provide read receipts."
        case "failed", "sending_failed", "delivery_failed": return "The message was not delivered."
        case "unavailable", "status_unavailable": return "Telnyx no longer has a retrievable delivery record."
        default: return "Message delivery status."
        }
    }
}

private struct MessageAttachmentView: View {
    let url: URL
    @State private var showingViewer = false

    var body: some View {
        Button { showingViewer = true } label: {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else if phase.error != nil {
                    VStack(spacing: 6) {
                        Image(systemName: "photo.badge.exclamationmark")
                        Text("Image unavailable").font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: 240, minHeight: 100, maxHeight: 260)
            .clipped()
            .cornerRadius(12)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Message image")
        .accessibilityHint("Opens the image with options to save or share it")
        .sheet(isPresented: $showingViewer) {
            MessageImageViewer(url: url)
        }
    }
}

private struct MessageImageViewer: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var isSaving = false
    @State private var notice: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else if phase.error != nil {
                        VStack(spacing: 10) {
                            Image(systemName: "photo.badge.exclamationmark").font(.largeTitle)
                            Text("Image unavailable").font(.headline)
                            Text("The attachment could not be downloaded.").font(.footnote)
                        }
                        .multilineTextAlignment(.center)
                            .foregroundStyle(.white)
                    } else {
                        ProgressView().tint(.white)
                    }
                }
                .padding()
            }
            .navigationTitle("Image")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.black, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up")
                    }
                    Button(action: save) {
                        if isSaving { ProgressView().tint(.white) }
                        else { Image(systemName: "square.and.arrow.down") }
                    }
                    .disabled(isSaving)
                    .accessibilityLabel("Save image to Photos")
                }
            }
        }
        .alert("Image", isPresented: Binding(
            get: { notice != nil },
            set: { if !$0 { notice = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(notice ?? "")
        }
    }

    private func save() {
        isSaving = true
        Task {
            defer { isSaving = false }
            do {
                try await PhotoLibrarySaver.saveImage(from: url)
                notice = "Saved to Photos."
            } catch {
                notice = error.localizedDescription
            }
        }
    }
}

struct InitialsAvatar: View {
    let name: String
    let imageURL: String?

    var body: some View {
        ZStack {
            Circle().fill(ViciTheme.avatarFill)
            if let imageURL, let url = URL(string: imageURL) {
                AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { initials }
                    .clipShape(Circle())
            } else { initials }
        }.frame(width: 44, height: 44)
    }

    private var initials: some View {
        Text(String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()).font(.subheadline.bold())
            .foregroundStyle(ViciTheme.onAvatar)
    }
}

struct EmptyState: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 38)).foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(detail).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding()
    }
}
