import SwiftUI
import UIKit

/// Team management: who is on the account, what role they hold, and pending
/// invitations. Reached from Settings and shown only to accounts that hold
/// `user.manage`.
///
/// Hiding this screen is a courtesy, not a control. Every action below is
/// enforced independently by the server on the request itself.
struct TeamView: View {
    @StateObject private var model = TeamModel()
    @EnvironmentObject private var session: SessionModel
    @State private var showingInvite = false

    var body: some View {
        List {
            if model.isLoading && model.members.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }

            Section {
                if model.members.isEmpty && !model.isLoading {
                    Text("No members yet").foregroundStyle(.secondary)
                }
                ForEach(model.members) { member in
                    NavigationLink {
                        TeamMemberView(member: member, model: model)
                    } label: {
                        TeamMemberRow(member: member,
                                      isCurrentUser: member.id == session.currentUser?.id)
                    }
                }
            } header: {
                Text("Members")
            } footer: {
                Text("Roles decide what each person can do. The server enforces them on every request, so changing a role takes effect immediately, even on a device that is already signed in.")
            }

            if !model.invitations.filter({ !$0.isAccepted }).isEmpty {
                Section("Pending invitations") {
                    ForEach(model.invitations.filter { !$0.isAccepted }) { invitation in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(invitation.email ?? "Invited member")
                            Text(RoleCatalog.label(invitation.role))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Team")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showingInvite = true } label: {
                    Image(systemName: "person.badge.plus")
                }
                .accessibilityLabel("Invite a member")
            }
        }
        .refreshable { await model.load() }
        .task { if model.members.isEmpty { await model.load() } }
        .sheet(isPresented: $showingInvite) {
            InviteSheet(model: model)
        }
        .alert("Team error", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) { Button("OK", role: .cancel) {} } message: {
            Text(model.errorMessage ?? "Unknown error")
        }
    }
}

private struct TeamMemberRow: View {
    let member: TeamMember
    let isCurrentUser: Bool

    var body: some View {
        HStack(spacing: 12) {
            InitialsAvatar(name: member.name, imageURL: nil)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(member.name).fontWeight(.semibold)
                    if isCurrentUser {
                        Text("You").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Text(member.email ?? "No email")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 3) {
                Text(RoleCatalog.label(member.role))
                    .font(.caption2)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(Capsule())
                if !member.active {
                    Text("Deactivated")
                        .font(.caption2)
                        .foregroundColor(ViciTheme.destructive)
                }
            }
        }
    }
}

private struct TeamMemberView: View {
    let member: TeamMember
    @ObservedObject var model: TeamModel
    @EnvironmentObject private var session: SessionModel
    @Environment(\.dismiss) private var dismiss
    @State private var selectedRole: String
    @State private var confirmingDeactivate = false

    init(member: TeamMember, model: TeamModel) {
        self.member = member
        _model = ObservedObject(wrappedValue: model)
        _selectedRole = State(initialValue: member.role ?? RoleCatalog.seeds.first ?? "agent")
    }

    /// Nil when the change is allowed. Mirrors the server's 409
    /// `CANNOT_DEACTIVATE_LAST_OWNER` so the last admin is told before tapping.
    private var blockingReason: String? {
        model.blockingReason(for: member, currentUserID: session.currentUser?.id)
    }

    private var isBusy: Bool { model.busyMemberID == member.id }

    var body: some View {
        List {
            Section {
                LabeledContent("Name", value: member.name)
                LabeledContent("Email", value: member.email ?? "—")
                LabeledContent("Status", value: member.active ? "Active" : "Deactivated")
                if let lastSeen = member.lastSeenDate {
                    LabeledContent("Last seen") { Text(lastSeen, style: .relative) }
                }
            }

            Section {
                Picker("Role", selection: $selectedRole) {
                    ForEach(roleOptions, id: \.self) { role in
                        Text(RoleCatalog.label(role)).tag(role)
                    }
                }
                .disabled(isBusy || blockingReason != nil)

                Button {
                    Task { _ = await model.changeRole(of: member, to: selectedRole) }
                } label: {
                    if isBusy { ProgressView() } else { Text("Save role") }
                }
                .disabled(isBusy || blockingReason != nil || selectedRole == (member.role ?? ""))
            } header: {
                Text("Role")
            } footer: {
                if let blockingReason {
                    Text(blockingReason).foregroundColor(ViciTheme.destructive)
                } else {
                    Text("A role change applies on the person's next request. They are not signed out and their phone keeps ringing.")
                }
            }

            if member.active {
                Section {
                    Button("Deactivate member", role: .destructive) {
                        confirmingDeactivate = true
                    }
                    .disabled(isBusy || blockingReason != nil)
                } footer: {
                    Text("A deactivated member cannot sign in or use the inbox. Their history stays in the activity log.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Deactivate \(member.name)?",
                            isPresented: $confirmingDeactivate,
                            titleVisibility: .visible) {
            Button("Deactivate", role: .destructive) {
                Task {
                    if await model.deactivate(member) { dismiss() }
                }
            }
            Button("Keep active", role: .cancel) {}
        } message: {
            Text("They lose access to the inbox immediately.")
        }
    }

    /// The member's own role is always offered, even if this client has never
    /// heard of it, so opening the screen cannot silently rewrite it.
    private var roleOptions: [String] {
        var options = model.availableRoles
        if let role = member.role, !options.contains(role) { options.insert(role, at: 0) }
        return options
    }
}

/// Invite by email. The creation response carries a one-time token and URL —
/// there is no email sender configured, so the link is shown here once and must
/// be copied before this sheet is closed.
private struct InviteSheet: View {
    @ObservedObject var model: TeamModel
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var role = RoleCatalog.seeds.first ?? "agent"
    @State private var isWorking = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Form {
                if let invitation = model.newInvitation {
                    Section {
                        Text(invitation.email ?? email)
                            .font(.subheadline.weight(.semibold))
                        if let link = invitation.inviteUrl ?? invitation.inviteToken {
                            Text(link)
                                .font(.system(.footnote, design: .monospaced))
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                            Button {
                                UIPasteboard.general.string = link
                                copied = true
                            } label: {
                                Label(copied ? "Link copied" : "Copy invite link",
                                      systemImage: copied ? "checkmark" : "doc.on.doc")
                            }
                        }
                    } header: {
                        Text("Invitation created")
                    } footer: {
                        Text("This link is shown once and cannot be retrieved later. Send it to them yourself — no invitation email is sent.")
                    }
                } else {
                    Section("Invite") {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("Role", selection: $role) {
                            ForEach(model.availableRoles, id: \.self) { value in
                                Text(RoleCatalog.label(value)).tag(value)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.newInvitation == nil ? "Cancel" : "Done") {
                        model.newInvitation = nil
                        dismiss()
                    }
                }
                if model.newInvitation == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(isWorking ? "Inviting…" : "Invite") {
                            isWorking = true
                            Task {
                                _ = await model.invite(email: email.trimmingCharacters(in: .whitespaces),
                                                       role: role)
                                isWorking = false
                            }
                        }
                        .disabled(email.trimmingCharacters(in: .whitespaces).isEmpty || isWorking)
                    }
                }
            }
        }
    }
}
