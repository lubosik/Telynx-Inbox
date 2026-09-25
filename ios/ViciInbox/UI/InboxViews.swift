import SwiftUI
import PhotosUI
import UIKit

private enum InboxAudience: String, CaseIterable, Identifiable {
    case all
    case vip

    var id: String { rawValue }
    var label: String { self == .all ? "All Customers" : "VIP" }
}

private enum VIPFocus: String, CaseIterable, Identifiable {
    case all
    case pastTiming
    case atTiming
    case withinTiming
    case noTiming

    var id: String { rawValue }

    func includes(_ conversation: ConversationSummary) -> Bool {
        switch self {
        case .all: return true
        case .pastTiming: return conversation.vipState == "needs_attention"
        case .atTiming: return conversation.vipState == "due_soon"
        case .withinTiming:
            return conversation.vipState == "active" && conversation.typicalOrderGapDays != nil
        case .noTiming: return conversation.typicalOrderGapDays == nil
        }
    }

    var label: String {
        switch self {
        case .all: return "All VIPs"
        case .pastTiming: return "Past timing"
        case .atTiming: return "At timing"
        case .withinTiming: return "Within timing"
        case .noTiming: return "No pattern"
        }
    }
}

struct InboxView: View {
    @ObservedObject var model: InboxModel
    @State private var search = ""
    @State private var audience: InboxAudience = .all
    @State private var vipFocus: VIPFocus = .all
    @State private var showingVIPCampaign = false
    @State private var showingVIPPlaybook = false
    @EnvironmentObject private var router: AppRouter
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    private var audienceConversations: [ConversationSummary] {
        switch audience {
        case .all: return model.conversations
        case .vip: return model.conversations.filter(\.isVIP).filter(vipFocus.includes)
        }
    }

    private var vipConversations: [ConversationSummary] {
        model.conversations.filter(\.isVIP)
    }

    private var filtered: [ConversationSummary] {
        guard !search.isEmpty else { return audienceConversations }
        let query = search.lowercased()
        return audienceConversations.filter {
            $0.displayName.lowercased().contains(query) ||
            $0.phone.lowercased().contains(query) ||
            ($0.email?.lowercased().contains(query) ?? false)
        }
    }

    private var vipCount: Int { model.conversations.filter(\.isVIP).count }
    private var vipNeedsAttentionCount: Int {
        model.conversations.filter { $0.isVIP && $0.vipNeedsAttention }.count
    }
    private var vipAtTimingCount: Int {
        vipConversations.filter { $0.vipState == "due_soon" }.count
    }
    private var vipWithinTimingCount: Int {
        vipConversations.filter { $0.vipState == "active" && $0.typicalOrderGapDays != nil }.count
    }
    private var vipNoTimingCount: Int {
        vipConversations.filter { $0.typicalOrderGapDays == nil }.count
    }
    private var vipLifetimeSpend: Double {
        Double(vipConversations.reduce(0) { $0 + ($1.lifetimeSpendCents ?? 0) }) / 100
    }
    private var vipSegmentID: String? {
        vipConversations.compactMap(\.vipSegmentID).first { !$0.isEmpty }
    }

    var body: some View {
        NavigationStack(path: $router.inboxPath) {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Customer view", selection: $audience) {
                        Text("All Customers").tag(InboxAudience.all)
                        Text("VIP \(vipCount)").tag(InboxAudience.vip)
                    }
                    .pickerStyle(.segmented)

                    if audience == .vip, vipCount > 0 {
                        VIPWorkspaceCard(
                            total: vipCount,
                            lifetimeSpend: vipLifetimeSpend,
                            pastTiming: vipNeedsAttentionCount,
                            atTiming: vipAtTimingCount,
                            withinTiming: vipWithinTimingCount,
                            noTiming: vipNoTimingCount,
                            focus: $vipFocus,
                            canManage: session.can(Permission.campaignsManage),
                            canOpenAudience: session.can(Permission.campaignsRead) && vipSegmentID != nil,
                            workPriority: { vipFocus = .pastTiming },
                            draftCampaign: { showingVIPCampaign = true },
                            showOffers: { showingVIPPlaybook = true },
                            openAudience: {
                                guard let vipSegmentID else { return }
                                router.open(.segment(id: vipSegmentID, name: "Best Repeat Customers"))
                            }
                        )
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 10)

                Divider()

                Group {
                    if model.isLoading && model.conversations.isEmpty {
                        ProgressView("Loading inbox…")
                    } else if filtered.isEmpty {
                        EmptyState(
                            icon: audience == .vip ? "crown" : "message",
                            title: audience == .vip ? "No VIP customers" : "No conversations",
                            detail: emptyDetail
                        )
                    } else {
                        List(filtered) { conversation in
                            NavigationLink(value: AppRoute.conversation(phone: conversation.phone)) {
                                ConversationRow(conversation: conversation)
                            }
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
            .navigationTitle("Inbox")
            .navigationDestination(for: AppRoute.self) { route in
                if case .conversation(let phone) = route {
                    ConversationDestinationView(phone: phone, model: model)
                } else if case .referral(let id, let phone) = route {
                    ConversationDestinationView(phone: phone, referralID: id, model: model)
                } else {
                    EmptyView()
                }
            }
            .searchable(text: $search, prompt: "Name or phone")
            .sheet(isPresented: $showingVIPCampaign) {
                CampaignEditorView(initialContacts: vipConversations) {
                    Task { await model.load() }
                }
            }
            .sheet(isPresented: $showingVIPPlaybook) {
                VIPPlaybookSheet()
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
        }
    }

    private var emptyDetail: String {
        if !search.isEmpty { return "Try another search." }
        if audience == .vip {
            if vipCount > 0 && vipFocus != .all {
                return "No VIP customers are currently in this timing group."
            }
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

    private var conversation: ConversationSummary? {
        model.conversations.first { $0.phone == phone }
    }

    var body: some View {
        Group {
            if let conversation {
                MessageThreadView(conversation: conversation,
                                  model: model,
                                  referralID: referralID)
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
                    if conversation.isVIP {
                        CustomerTag(text: "VIP", systemImage: "crown.fill", color: .orange)
                    }
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
                if conversation.isVIP, let state = conversation.vipStateLabel {
                    VStack(alignment: .leading, spacing: 3) {
                        CustomerTag(
                            text: state,
                            systemImage: conversation.vipNeedsAttention ? "exclamationmark.circle.fill" : "clock",
                            color: conversation.vipNeedsAttention ? .orange : ViciTheme.tealFill
                        )
                        if let value = conversation.vipValueSummary {
                            Text(value)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        if let detail = conversation.vipTimingDetail {
                            Text(detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                } else if let progress = conversation.vipProgressLabel {
                    CustomerTag(text: progress, systemImage: "arrow.up.right", color: ViciTheme.tealFill)
                }
            }
        }
        .padding(.horizontal, conversation.isVIP ? 8 : 0)
        .padding(.vertical, conversation.isVIP ? 8 : 4)
        .background {
            if conversation.isVIP {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color.yellow.opacity(0.055))
            }
        }
        .overlay {
            if conversation.isVIP {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(red: 0.78, green: 0.58, blue: 0.16).opacity(0.72), lineWidth: 1)
            }
        }
    }

    private var preview: String {
        if let body = conversation.lastMessage?.body, !body.isEmpty { return body }
        if !(conversation.lastMessage?.mediaURLs ?? []).isEmpty { return "Photo" }
        return conversation.latestOrderStatus.map { "Order: \($0.replacingOccurrences(of: "-", with: " "))" } ?? conversation.phone
    }
}

private struct VIPWorkspaceCard: View {
    let total: Int
    let lifetimeSpend: Double
    let pastTiming: Int
    let atTiming: Int
    let withinTiming: Int
    let noTiming: Int
    @Binding var focus: VIPFocus
    let canManage: Bool
    let canOpenAudience: Bool
    let workPriority: () -> Void
    let draftCampaign: () -> Void
    let showOffers: () -> Void
    let openAudience: () -> Void

    private func count(for candidate: VIPFocus) -> Int {
        switch candidate {
        case .all: return total
        case .pastTiming: return pastTiming
        case .atTiming: return atTiming
        case .withinTiming: return withinTiming
        case .noTiming: return noTiming
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Label("VIP customers", systemImage: "crown.fill")
                    .font(.headline)
                    .foregroundStyle(Color(red: 0.64, green: 0.45, blue: 0.08))
                Spacer()
                Text(lifetimeSpend.formatted(.currency(code: "USD")))
                    .font(.subheadline.weight(.bold))
            }
            Text("Automatic rule: 3+ paid orders and $500+ lifetime spend. Approved manual additions appear here too. The combined lifetime spend is shown above.")
                .font(.caption)
                .foregroundStyle(.secondary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(VIPFocus.allCases) { candidate in
                        Button {
                            focus = candidate
                        } label: {
                            Text("\(candidate.label) \(count(for: candidate))")
                                .font(.caption.weight(.semibold))
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .background(focus == candidate ? Color.yellow.opacity(0.28) : Color.gray.opacity(0.09), in: Capsule())
                                .overlay(Capsule().stroke(focus == candidate ? Color.orange.opacity(0.65) : Color.clear))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if pastTiming > 0 {
                Text("Past timing means more than 1.5 times a customer's reliable personal order gap. It is a priority list, not an unread message or an unresolved support task.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 10) {
                Button(action: workPriority) {
                    Label("Work priority list", systemImage: "list.bullet.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.68, green: 0.48, blue: 0.09))

                Button(action: showOffers) {
                    Label("VIP offers", systemImage: "gift.fill")
                }
                .buttonStyle(.bordered)
            }
            .font(.caption.weight(.semibold))

            if canManage || canOpenAudience {
                HStack(spacing: 10) {
                    if canManage {
                        Button(action: draftCampaign) {
                            Label("Draft VIP campaign", systemImage: "square.and.pencil")
                        }
                        .buttonStyle(.bordered)
                    }
                    if canOpenAudience {
                        Button(action: openAudience) {
                            Label("Open VIP audience", systemImage: "person.3")
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .font(.caption.weight(.semibold))
            }

            Text("No message is sent from this VIP screen. Open one customer for a personal conversation, or create a draft that still goes through preview, eligibility, review and scheduling.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .background(
            LinearGradient(colors: [Color.yellow.opacity(0.13), Color.orange.opacity(0.045)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(Color(red: 0.75, green: 0.55, blue: 0.13).opacity(0.75), lineWidth: 1)
        )
    }
}

private struct VIPPlaybookSheet: View {
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

    private var messages: [MessageRecord] { model.messages[conversation.phone] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            if let referralID = activeReferralID ?? referralID {
                ReferralContextBanner(referralID: referralID)
            }
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
    let reply: () -> Void
    let react: (String) -> Void
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
