import SwiftUI
import UIKit

/// Team management: who is on the account, what role they hold, and pending
/// invitations. Reached from the account menu and shown only to accounts that
/// hold `user.manage`.
///
/// Hiding this screen is a courtesy, not a control. Every action below is
/// enforced independently by the server on the request itself.
///
/// Role names on this screen come from the server's catalogue, which arrives
/// with the member list in the same `GET /api/users` payload. Nothing here
/// prints a role key: the product calls `agent` "Support Agent", and the only
/// authority for that is `sms_roles`.
struct TeamView: View {
    @StateObject private var model = TeamModel()
    @EnvironmentObject private var session: SessionModel
    @State private var showingInvite = false

    private var actor: TeamActor {
        TeamActor(id: session.currentUser?.id,
                  canManageOwners: session.can(Permission.userManageOwner))
    }

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
                                      roleLabel: model.roleLabel(member.role),
                                      isCurrentUser: member.id == session.currentUser?.id)
                    }
                }
            } header: {
                Text("Members")
            } footer: {
                Text("Roles decide what each person can do. The server enforces them on every request, so changing a role takes effect immediately, even on a device that is already signed in.")
            }

            if !model.pendingInvitations.isEmpty {
                Section {
                    ForEach(model.pendingInvitations) { invitation in
                        PendingInvitationRow(invitation: invitation,
                                             roleLabel: model.roleLabel(invitation.role))
                    }
                } header: {
                    Text("Pending invitations")
                } footer: {
                    Text("An invitation stops working once it expires. The one-time link is shown only when the invitation is created and cannot be retrieved afterwards.")
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
            InviteSheet(model: model, actor: actor)
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
    let roleLabel: String
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
                Text(roleLabel)
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

private struct PendingInvitationRow: View {
    let invitation: Invitation
    let roleLabel: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(invitation.name).fontWeight(.semibold)
            if let email = invitation.email, email != invitation.displayName {
                Text(email).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                Text(roleLabel).font(.caption).foregroundStyle(.secondary)
                if let expiry = invitation.expiresDate {
                    Text("· expires \(expiry, style: .relative)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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

    private var actor: TeamActor {
        TeamActor(id: session.currentUser?.id,
                  canManageOwners: session.can(Permission.userManageOwner))
    }

    /// Nil when the change is allowed. Covers both server-side rules: the
    /// peer-Owner guard (409 `CANNOT_MODIFY_PEER_OWNER`) and the
    /// last-administrator guard (409 `CANNOT_DEACTIVATE_LAST_OWNER`). Both are
    /// shown before the tap rather than after the failure.
    private var blockingReason: String? {
        model.restriction(on: member, actor: actor)
    }

    private var isBusy: Bool { model.busyMemberID == member.id }

    var body: some View {
        List {
            Section {
                LabeledContent("Name", value: member.name)
                LabeledContent("Email", value: member.email ?? "Not available")
                LabeledContent("Role", value: model.roleLabel(member.role))
                LabeledContent("Status", value: member.active ? "Active" : "Deactivated")
                if let lastSeen = member.lastSeenDate {
                    LabeledContent("Last seen") { Text(lastSeen, style: .relative) }
                }
            }

            Section {
                Picker("Role", selection: $selectedRole) {
                    ForEach(roleOptions, id: \.self) { role in
                        Text(model.roleLabel(role)).tag(role)
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
                // Disabled with an explanation, never hidden. A control that
                // silently vanishes reads as a bug; a control that is greyed
                // out with a sentence beside it teaches the rule.
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
                    if let blockingReason {
                        Text(blockingReason).foregroundColor(ViciTheme.destructive)
                    } else {
                        Text("A deactivated member cannot sign in or use the inbox. Their history stays in the activity log.")
                    }
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
    /// heard of it or the actor could not assign it fresh, so opening the
    /// screen cannot silently rewrite it.
    ///
    /// Owner appears here for an actor holding `user.manage.owner`: promoting
    /// somebody to Owner is supported and the database permits more than one.
    /// What is refused is acting on somebody who is *already* an Owner, and
    /// that is handled by `blockingReason` disabling the whole section.
    private var roleOptions: [String] {
        var options = model.assignableRoles(for: actor)
        if let role = member.role, !options.contains(role) { options.insert(role, at: 0) }
        return options
    }
}

/// Invite somebody by name and email.
///
/// The name field is the fix for a broken form: `POST /api/invitations`
/// validates `displayName` and answers 400 `INVALID_DISPLAY_NAME` without it,
/// and this sheet had nowhere to type one, so every invitation failed with an
/// error the admin could not act on.
private struct InviteSheet: View {
    @ObservedObject var model: TeamModel
    let actor: TeamActor
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var email = ""
    @State private var role = ""
    @State private var isWorking = false
    @State private var copied = false

    private var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Mirrors the server's two validations so the admin is told before the
    /// round trip, not after it. The server checks both again regardless.
    private var validationProblem: String? {
        if trimmedName.isEmpty { return "Enter the person's name." }
        if trimmedName.count > 120 { return "That name is longer than 120 characters." }
        if trimmedEmail.isEmpty { return "Enter their email address." }
        // Deliberately loose. The server owns the real pattern; this only
        // catches an obvious typo before a network round trip.
        guard trimmedEmail.contains("@"), trimmedEmail.contains("."),
              !trimmedEmail.hasPrefix("@"), !trimmedEmail.hasSuffix("@") else {
            return "That does not look like an email address."
        }
        if role.isEmpty { return "Choose a role." }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let created = model.newInvitation {
                    InvitationResultSection(created: created,
                                            fallbackName: trimmedName,
                                            fallbackEmail: trimmedEmail,
                                            roleLabel: model.roleLabel(created.invitation?.role ?? role),
                                            copied: $copied)
                } else {
                    // Name, Email, Role — in that order, because that is the
                    // order the request is built in and the order a person
                    // thinks about somebody they are adding.
                    Section("Invite") {
                        TextField("Name", text: $name)
                            .textContentType(.name)
                            .textInputAutocapitalization(.words)
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Picker("Role", selection: $role) {
                            ForEach(model.assignableRoles(for: actor), id: \.self) { value in
                                Text(model.roleLabel(value)).tag(value)
                            }
                        }
                    }

                    if let validationProblem, !trimmedName.isEmpty || !trimmedEmail.isEmpty {
                        Section {
                            Text(validationProblem)
                                .font(.footnote)
                                .foregroundColor(ViciTheme.destructive)
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
                                _ = await model.invite(name: trimmedName,
                                                       email: trimmedEmail,
                                                       role: role)
                                isWorking = false
                            }
                        }
                        .disabled(validationProblem != nil || isWorking)
                    }
                }
            }
            .onAppear {
                let options = model.assignableRoles(for: actor)
                if role.isEmpty { role = options.first ?? RoleCatalog.seeds.first ?? "agent" }
            }
        }
    }
}

/// What happened, told honestly.
///
/// The rule this section exists to keep: never say an email was sent unless
/// the server said so. An absent flag is not a yes. Today the backend has no
/// email sender at all and says so in its own response; an email provider is
/// being added by another workstream, so all three outcomes — sent, not sent,
/// and not reported — are handled rather than assumed.
private struct InvitationResultSection: View {
    let created: InvitationCreation
    let fallbackName: String
    let fallbackEmail: String
    let roleLabel: String
    @Binding var copied: Bool

    private var personName: String { created.invitation?.displayName ?? fallbackName }
    private var personEmail: String { created.invitation?.email ?? fallbackEmail }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 3) {
                Text(personName.isEmpty ? personEmail : personName)
                    .font(.subheadline.weight(.semibold))
                if !personEmail.isEmpty, personEmail != personName {
                    Text(personEmail).font(.caption).foregroundStyle(.secondary)
                }
                Text(roleLabel).font(.caption).foregroundStyle(.secondary)
            }

            emailStatus

            if let secret = created.shareableSecret {
                Text(secret)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    UIPasteboard.general.string = secret
                    copied = true
                } label: {
                    Label(copied
                          ? (created.isBareToken ? "Token copied" : "Link copied")
                          : (created.isBareToken ? "Copy invite token" : "Copy link"),
                          systemImage: copied ? "checkmark" : "doc.on.doc")
                }
            }
        } header: {
            Text("Invitation created")
        } footer: {
            Text(footerText)
        }
    }

    @ViewBuilder
    private var emailStatus: some View {
        switch created.emailOutcome {
        case .sent(let address):
            Label {
                Text("Invitation email sent to \(address ?? personEmail).")
            } icon: {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(ViciTheme.success)
            }
            .font(.footnote)
        case .notSent:
            Label {
                Text(created.emailFailureExplanation.map { "No invitation email was sent. \($0)" }
                     ?? "No invitation email was sent.")
            } icon: {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(ViciTheme.warning)
            }
            .font(.footnote)
        case .unknown:
            Label {
                Text("This server did not report sending an invitation email.")
            } icon: {
                Image(systemName: "info.circle.fill").foregroundStyle(.secondary)
            }
            .font(.footnote)
        }
    }

    private var footerText: String {
        guard created.shareableSecret != nil else {
            // Nothing to copy and nothing claimed. Better to say so than to
            // show an empty box that looks like it worked.
            return "The invitation exists, but this server returned no link or token for it. Ask them to check with an administrator before this expires."
        }
        let shown = created.isBareToken
            ? "The token above is all the server returned. No acceptance link could be built."
            : "The link above is shown once and cannot be retrieved later."
        switch created.emailOutcome {
        case .sent:
            return "\(shown) Keep it in case the email does not arrive."
        case .notSent, .unknown:
            return "\(shown) Send it to them yourself, over a channel you trust."
        }
    }
}
