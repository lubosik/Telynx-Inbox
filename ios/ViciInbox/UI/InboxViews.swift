import SwiftUI
import PhotosUI
import UIKit

struct InboxView: View {
    @ObservedObject var model: InboxModel
    @State private var search = ""
    @State private var messageMatches: [ConversationSearchMatch] = []
    @State private var searchedTerm = ""
    @State private var isSearchingMessages = false
    @State private var searchError: String?
    @State private var selectedMatchIDs: [String: String] = [:]
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    private var audienceConversations: [ConversationSummary] {
        model.conversations.filter(workspace.includes)
    }

    private var filtered: [ConversationSummary] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return audienceConversations }
        let hitPhones = Set(messageMatches.map(\.contactPhone))
        return audienceConversations.filter {
            $0.displayName.lowercased().contains(query) ||
            $0.phone.lowercased().contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false) ||
            (searchedTerm == query && hitPhones.contains($0.phone))
        }
    }

    private var matchByPhone: [String: ConversationSearchMatch] {
        guard searchedTerm == search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return [:] }
        return Dictionary(uniqueKeysWithValues: messageMatches.map { ($0.contactPhone, $0) })
    }

    var body: some View {
        NavigationStack(path: $router.inboxPath) {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Inbox", selection: $workspace) {
                        ForEach(InboxWorkspace.allCases) { value in
                            Text(value.label).tag(value)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                .padding(.horizontal)
                .padding(.vertical, 10)

                Divider()

                if isSearchingMessages && !search.isEmpty {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Searching messages…").font(.caption).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal).padding(.vertical, 6)
                } else if let searchError, !search.isEmpty {
                    Text(searchError).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal).padding(.vertical, 6)
                }

                Group {
                    if model.isLoading && model.conversations.isEmpty {
                        ProgressView("Loading inbox…")
                    } else if filtered.isEmpty && isSearchingMessages {
                        ProgressView("Searching messages…")
                    } else if filtered.isEmpty {
                        EmptyState(
                            icon: workspace == .vip ? "crown" : "message",
                            title: workspace == .vip ? "No VIP customers" : "No conversations",
                            detail: emptyDetail
                        )
                    } else {
                        List(filtered) { conversation in
                            Button {
                                selectedMatchIDs[conversation.phone] = matchByPhone[conversation.phone]?.id.rawValue
                                router.inboxPath.append(AppRoute.conversation(phone: conversation.phone))
                            } label: {
                                ConversationRow(conversation: conversation, match: matchByPhone[conversation.phone])
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                vipActions(for: conversation)
                            }
                            .contextMenu { vipActions(for: conversation) }
                        }
                        .listStyle(.plain)
                        .refreshable { await model.load() }
                    }
                }
            }
            .navigationTitle(workspace == .vip ? "VIP Inbox" : "Main Inbox")
            .navigationDestination(for: AppRoute.self) { route in
                if case .conversation(let phone) = route {
                    ConversationDestinationView(phone: phone, model: model,
                                                focusMessageID: selectedMatchIDs[phone])
                } else if case .referral(let id, let phone) = route {
                    ConversationDestinationView(phone: phone, referralID: id, model: model)
                } else {
                    EmptyView()
                }
            }
            .searchable(text: $search, prompt: "Name, phone, or message")
            .task(id: search) {
                let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
                messageMatches = []
                searchedTerm = ""
                searchError = nil
                guard query.count >= 2 else { isSearchingMessages = false; return }
                isSearchingMessages = true
                do {
                    try await Task.sleep(nanoseconds: 300_000_000)
                    let matches = try await APIClient.shared.searchConversationMessages(query)
                    guard !Task.isCancelled else { return }
                    messageMatches = matches
                    searchedTerm = query.lowercased()
                } catch is CancellationError {
                    return
                } catch {
                    guard !Task.isCancelled else { return }
                    searchError = "Message search is unavailable. Name and phone search still work."
                }
                isSearchingMessages = false
            }
            // Settings, Team, Activity and Sign out all live behind the account
            // button now, which is on every tab rather than only on the two
            // that happened to have a gear icon. Inbox previously carried a
            // duplicate entry point because Analytics is hidden from roles
            // without `analytics.read`, and that would otherwise have taken
            // Sign Out with it.
            .accountToolbar()
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
            .onChange(of: notifications.inboxRefreshSequence) { _ in
                Task { await model.load() }
            }
            .onChange(of: scenePhase) { phase in
                guard phase == .active else { return }
                Task { await model.load() }
            }
            .onChange(of: router.inboxPath) { path in
                if path.isEmpty { selectedMatchIDs.removeAll() }
            }
        }
    }

    private var emptyDetail: String {
        if !search.isEmpty { return "Try another search." }
        if workspace == .vip {
            return "Customers with 3+ paid orders and $500+ lifetime spend appear here automatically."
        }
        return "Messages will appear here."
    }

    @ViewBuilder
    private func vipActions(for conversation: ConversationSummary) -> some View {
        if session.can(Permission.campaignsManage),
           let segmentID = conversation.vipSegmentID, !segmentID.isEmpty {
            if !conversation.isVIP {
                Button {
                    Task { await model.addToVIP(conversation) }
                } label: {
                    Label("Add to VIP", systemImage: "crown.fill")
                }
                .tint(ViciTheme.tealFill)
                .disabled(model.vipUpdates.contains(conversation.phone))
            } else if conversation.isManualOnlyVIP {
                Button(role: .destructive) {
                    Task { await model.removeManualVIP(conversation) }
                } label: {
                    Label("Remove manual VIP", systemImage: "crown")
                }
                .disabled(model.vipUpdates.contains(conversation.phone))
            }
        }
    }
}

/// Resolves a stable phone route against the current inbox snapshot. A push can
/// arrive before the first inbox page, so the destination owns the loading state
/// instead of requiring the notification delegate to race the list.
private struct ConversationDestinationView: View {
    let phone: String
    var referralID: String? = nil
    @ObservedObject var model: InboxModel
    var focusMessageID: String? = nil
    @AppStorage(InboxWorkspace.storageKey) private var workspace: InboxWorkspace = .main

    private var conversation: ConversationSummary? {
        model.conversations.first { $0.phone == phone }
    }

    var body: some View {
        Group {
            if let conversation {
                MessageThreadView(conversation: conversation,
                                  model: model,
                                  referralID: referralID,
                                  focusMessageID: focusMessageID)
            } else if model.isLoading {
                ProgressView("Loading conversation")
            } else {
                EmptyState(icon: "message.badge",
                           title: "Conversation unavailable",
                           detail: "This conversation could not be found in the inbox.")
            }
        }
        .task {
            if conversation == nil { await model.load() }
        }
        // Pushes can arrive before the inbox snapshot. Follow authoritative
        // membership when it arrives without clearing paths or draft text.
        .task(id: conversation?.customerTier) {
            if let conversation { workspace = InboxWorkspace.destination(for: conversation) }
        }
    }
}

private struct ConversationRow: View {
    let conversation: ConversationSummary
    var match: ConversationSearchMatch? = nil

    var body: some View {
        HStack(spacing: 12) {
            InitialsAvatar(name: conversation.displayName, imageURL: conversation.avatarURL)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(conversation.displayName).fontWeight((conversation.unreadCount ?? 0) > 0 ? .semibold : .regular)
                    if conversation.isVIP {
                        CustomerTag(text: "VIP", systemImage: "crown.fill", color: .orange)
                    }
                    Spacer()
                    if let date = ServerDate.parse(match?.createdAt ?? conversation.lastMessage?.createdAt) {
                        Text(date, style: .relative).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 5) {
                    if (match?.direction ?? conversation.lastMessage?.direction) == "outbound" {
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
        .opacity(conversation.lastMessage == nil ? 0.65 : 1)
    }

    private var preview: String {
        if let body = match?.body, !body.isEmpty { return body }
        if let body = conversation.lastMessage?.body, !body.isEmpty { return body }
        if !(conversation.lastMessage?.mediaURLs ?? []).isEmpty { return "Photo" }
        if conversation.lastMessage == nil {
            if let created = ServerDate.parse(conversation.createdAt),
               (0..<86_400).contains(Date().timeIntervalSince(created)) {
                return "New contact · no messages yet"
            }
            return "No messages yet"
        }
        return conversation.phone
    }
}

struct VIPPlaybookSheet: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("The spreadsheet showed repeat customers generated 55.7% of revenue and were worth 2.77 times a one-time buyer on average.", systemImage: "chart.line.uptrend.xyaxis")
                    Text("Those figures describe the WooCommerce history through September 22, 2026. They are context for prioritising relationships, not a promise of campaign revenue.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Why VIP matters")
                }

                Section {
                    VIPPlaybookRow(icon: "list.bullet.circle.fill",
                                   title: "Personal priority",
                                   detail: "Open Past timing and work customer by customer. Dominic can ask how Vici can serve them better, then decide whether a personal thank-you is appropriate.")
                    VIPPlaybookRow(icon: "sparkles",
                                   title: "Early access",
                                   detail: "Give VIPs the first look at verified new arrivals, restocks or a real perk. Confirm stock and the exact benefit before drafting copy.")
                    VIPPlaybookRow(icon: "square.stack.3d.up.fill",
                                   title: "Thoughtful cross-sell",
                                   detail: "Use purchase history to introduce one relevant new category. Keep every message about products and availability, with no outcome or dosing claims.")
                    VIPPlaybookRow(icon: "person.2.fill",
                                   title: "Concierge coaching",
                                   detail: "A complimentary session about a non-product tool, such as helping a VIP get started with Meta Muse, can be a loyalty benefit if Dominic is genuinely offering it.")
                } header: {
                    Text("Offer playbook")
                }

                Section {
                    Text("These are ideas, not live offers. Verify the benefit, inventory, coupon terms, fulfilment and audience first. A VIP label never replaces SMS consent, STOP, DND, quiet-hour or campaign-review checks.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Before anything sends")
                }
            }
            .navigationTitle("VIP offers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

private struct VIPPlaybookRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(Color(red: 0.68, green: 0.48, blue: 0.09))
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }
}

private struct CustomerTag: View {
    let text: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.1), in: Capsule())
    }
}

struct MessageThreadView: View {
    let conversation: ConversationSummary
    @ObservedObject var model: InboxModel
    var referralID: String? = nil
    var focusMessageID: String? = nil
    // Needed for the call button. Supplied at the app root (ViciInboxApp) and
    // inherited through the NavigationLink that pushes this view.
    @EnvironmentObject private var session: SessionModel
    @State private var draft = ""
    @State private var replyTarget: MessageRecord?
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var imageData: [Data] = []
    @State private var pickerLoadID = UUID()
    @State private var didInitialScroll = false
    @State private var showsReferralComposer = false
    @State private var activeReferralID: String?
    @State private var failedMessageToHide: MessageRecord?

    private var messages: [MessageRecord] { model.messages[conversation.phone] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            if let referralID = activeReferralID ?? referralID {
                ReferralContextBanner(referralID: referralID)
            }
            if let number = conversation.replyFromNumber, !number.isEmpty {
                Label("SMS replies from \(conversation.isVIP ? "VIP" : "main") line: \(PhoneFormatter.pretty(number))",
                      systemImage: conversation.isVIP ? "crown.fill" : "phone")
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity)
                Divider()
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(messages) { message in
                            MessageBubble(message: message, canDeleteFailed: session.can(Permission.messageSend)) {
                                replyTarget = message
                            } react: { type in
                                Task { await model.react(to: message, type: type, phone: conversation.phone) }
                            } deleteFailed: {
                                failedMessageToHide = message
                            }
                            .padding(message.id == focusMessageID ? 3 : 0)
                            .background(message.id == focusMessageID ? ViciTheme.tealFill.opacity(0.14) : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 12))
                            .id(message.id)
                        }
                    }
                    .padding(.horizontal).padding(.vertical, 10)
                }
                .onChange(of: messages.count) { _ in
                    guard let last = messages.last else { return }
                    if !didInitialScroll,
                       let focusMessageID,
                       messages.contains(where: { $0.id == focusMessageID }) {
                        proxy.scrollTo(focusMessageID, anchor: .center)
                        didInitialScroll = true
                    } else if didInitialScroll {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    } else {
                        proxy.scrollTo(last.id, anchor: .bottom)
                        didInitialScroll = true
                    }
                }
                .onAppear {
                    if let focusMessageID,
                       messages.contains(where: { $0.id == focusMessageID }) {
                        proxy.scrollTo(focusMessageID, anchor: .center)
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
        .confirmationDialog("Delete this failed message?", isPresented: Binding(
            get: { failedMessageToHide != nil },
            set: { if !$0 { failedMessageToHide = nil } }
        )) {
            if let message = failedMessageToHide {
                Button("Delete failed message", role: .destructive) {
                    Task { await model.hideFailedMessage(message, phone: conversation.phone) }
                }
            }
        } message: {
            Text("This removes it from the conversation. The failed delivery record is kept for troubleshooting. Nothing is resent.")
        }
        .navigationBarTitleDisplayMode(.inline)
        .task {
            while !Task.isCancelled {
                await model.loadThread(phone: conversation.phone)
                try? await Task.sleep(nanoseconds: 12_000_000_000)
            }
        }
        .onChange(of: pickerItems) { items in
            let loadID = UUID()
            pickerLoadID = loadID
            Task {
                var loaded: [Data] = []
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self) { loaded.append(data) }
                }
                guard pickerLoadID == loadID else { return }
                imageData = loaded
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if session.can(Permission.campaignsManage),
                   let segmentID = conversation.vipSegmentID, !segmentID.isEmpty {
                    Menu {
                        if conversation.isVIP {
                            Label(
                                conversation.isAutomaticVIP ? "VIP from paid-order history" : "Manually added to VIP",
                                systemImage: "checkmark.circle.fill"
                            )
                            if conversation.isManualOnlyVIP {
                                Button(role: .destructive) {
                                    Task { await model.removeManualVIP(conversation) }
                                } label: {
                                    Label("Remove manual VIP", systemImage: "crown")
                                }
                            }
                        } else {
                            Button {
                                Task { await model.addToVIP(conversation) }
                            } label: {
                                Label("Add to VIP", systemImage: "crown.fill")
                            }
                        }
                    } label: {
                        Image(systemName: conversation.isVIP ? "crown.fill" : "crown")
                    }
                    .disabled(model.vipUpdates.contains(conversation.phone))
                    .accessibilityLabel(conversation.isVIP ? "VIP customer options" : "Add customer to VIP")
                }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                if session.currentUser?.isSharedTeamLogin == false,
                   session.can(Permission.referralCreate) {
                    Button {
                        showsReferralComposer = true
                    } label: {
                        Label("Refer", systemImage: "person.2.fill")
                    }
                    .accessibilityHint("Hands this conversation to a teammate without sending a customer message")
                }
            }
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
        .sheet(isPresented: $showsReferralComposer) {
            ReferralComposerView(conversation: conversation) { referral in
                activeReferralID = referral.id
            }
        }
        .assistantDraftOwner(
            source: .message,
            isDirty: !draft.isEmpty || replyTarget != nil || !pickerItems.isEmpty || !imageData.isEmpty,
            onDiscard: {
                draft = ""
                replyTarget = nil
                pickerLoadID = UUID()
                pickerItems = []
                imageData = []
                showsReferralComposer = false
            }
        )
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
    let canDeleteFailed: Bool
    let reply: () -> Void
    let react: (String) -> Void
    let deleteFailed: () -> Void
    // The same timezone Settings displays and the appearance schedule uses:
    // the account's, the workspace default, or this device, in that order. A
    // bubble that read the device clock directly would disagree with the rest
    // of the app, and once the DATE is on screen that disagreement is visible
    // — an evening message in New York is the next day in London.
    @EnvironmentObject private var appearance: AppearanceModel
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
                        // Time AND date, matching the web inbox. `style: .time`
                        // showed only "7:04 PM", which is unambiguous while you
                        // are looking at it and useless in a screenshot read
                        // days later: you cannot tell a reply that came back in
                        // four minutes from one that came the next afternoon.
                        Text(MessageStamp.format(date, timeZone: appearance.effectiveTimeZone))
                            .font(.caption2).foregroundStyle(.secondary)
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
                if let line = message.businessPhone, !line.isEmpty {
                    Text("SMS line \(PhoneFormatter.pretty(line))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .contextMenu {
                if canDeleteFailed && !message.isInbound && message.numericID != nil
                    && ["failed", "sending_failed", "delivery_failed"].contains(message.status?.lowercased() ?? "") {
                    Button(role: .destructive, action: deleteFailed) {
                        Label("Delete failed message", systemImage: "trash")
                    }
                }
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
