import SwiftUI

/// The account button and the sheet behind it.
///
/// Activity and Team used to live two levels down, inside Settings, and the
/// owner's report was that nobody could find them. They are now one tap from
/// the top bar of every tab, alongside Settings and Sign out.
///
/// The tab bar carries five tabs, which is the most iPhone shows before iOS
/// collapses the rest into a "More" list. This sheet is how the app grows
/// without a sixth.

// MARK: - Toolbar entry point

extension View {
    /// Puts the account button on this screen's navigation bar.
    ///
    /// Applied to the root of every tab so the control is in the same place
    /// wherever the operator happens to be. Leading rather than trailing
    /// because three of the five tabs already own a trailing action.
    func accountToolbar() -> some View {
        modifier(AccountToolbarModifier())
    }
}

private struct AccountToolbarModifier: ViewModifier {
    @EnvironmentObject private var router: AppRouter

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    AccountAvatarButton { router.presentAccount() }
                }
            }
    }
}

/// A circular button showing the signed-in person's initials.
///
/// The touch target is 44x44 while the circle stays 30x30, and that gap is the
/// entire point of the `contentShape`.
///
/// This control was reported as needing two taps. It does not toggle anything,
/// there is no gesture competing with it and no keyboard to dismiss — the first
/// tap was simply missing it. A `Button` with a custom label and
/// `.buttonStyle(.plain)` is hosted in a bar button item as a custom view, and
/// a custom view gets none of the hit-slop UIKit gives a standard one; its
/// touch area is exactly its own bounds. Worse, the label's shape was a
/// `Circle().fill`, so the hittable region was the circle's path — about 707
/// square points against the 1,936 of Apple's 44x44 minimum, or 36% of it,
/// sited in the top-left corner of the screen where thumb accuracy is at its
/// worst. Every tap that landed in the corners of the 30pt box, or in the bar's
/// padding around it, did nothing at all.
///
/// `.contentShape(Rectangle())` inside a 44x44 frame makes the whole square
/// hittable including the corners, and the visual circle is unchanged.
struct AccountAvatarButton: View {
    @EnvironmentObject private var session: SessionModel
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(ViciTheme.avatarFill)
                if let initials = AccountIdentity.initials(for: session.currentUser) {
                    Text(initials)
                        .font(.caption.bold())
                        .foregroundStyle(ViciTheme.onAvatar)
                } else {
                    // The legacy shared-password session has no named identity,
                    // so there are no initials to show. A generic glyph is
                    // honest; inventing a placeholder like "VI" is not.
                    Image(systemName: "person.fill")
                        .font(.caption)
                        .foregroundStyle(ViciTheme.onAvatar)
                }
            }
            .frame(width: 30, height: 30)
            // Order matters: the frame is widened first, then the whole 44x44
            // is declared hittable. Reversing these two would set the content
            // shape on the 30pt box and change nothing.
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Keeps the 44pt box from pushing the title further right than the
        // 30pt circle used to. The extra 14pt is touch area, not layout.
        .padding(.leading, -7)
        .accessibilityLabel("Account")
        .accessibilityHint("Assistant, Activity, Team, Password, Settings, and Sign out")
    }
}

/// Initials and display text for whoever is signed in.
enum AccountIdentity {
    /// Nil when there is no named account, rather than a fabricated fallback.
    static func initials(for user: AuthUser?) -> String? {
        guard let source = user?.displayName ?? user?.email, !source.isEmpty else { return nil }
        // An email address has no surname to take a second letter from, so it
        // contributes one initial rather than two arbitrary characters.
        let words = source.split(whereSeparator: { $0 == " " || $0 == "." || $0 == "_" })
        let letters = words.prefix(2).compactMap { $0.first { $0.isLetter } }
        guard !letters.isEmpty else { return nil }
        return String(letters).uppercased()
    }

    static func name(for user: AuthUser?) -> String {
        user?.name ?? "Shared team login"
    }

    static func subtitle(for user: AuthUser?) -> String {
        guard let user else {
            return "Signed in with the shared team password"
        }
        if let email = user.email, !email.isEmpty { return email }
        return RoleCatalog.label(user.role)
    }
}

// MARK: - The sheet

struct AccountMenuSheet: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var router: AppRouter
    @Environment(\.dismiss) private var dismiss
    @State private var isSigningOut = false

    var body: some View {
        NavigationStack(path: $router.accountPath) {
            List {
                Section { AccountHeader(user: session.currentUser) }

                Section {
                    // Unlike the older compatibility gates, this pilot never
                    // fails open for an absent identity or permission list.
                    // The status endpoint independently repeats both checks.
                    if AssistantAccess.isPermitted(for: session.currentUser) {
                        AccountMenuLink(
                            title: "Assistant",
                            detail: "Private on-device assistant pilot and capability status.",
                            systemImage: "sparkles",
                            route: .assistant
                        )
                    }

                    if session.currentUser?.isSharedTeamLogin == false,
                       session.can(Permission.referralRead) {
                        AccountMenuLink(
                            title: "Referrals",
                            detail: "Customer conversations handed between named teammates.",
                            systemImage: "person.2.fill",
                            route: .referrals
                        )
                    }

                    // Permission gating, unchanged: Activity needs
                    // `audit.read`, Team needs `user.manage`. Hiding a row is a
                    // courtesy to the operator, never a control — the server
                    // rejects both endpoints for a role that lacks them.
                    if session.can(Permission.auditRead) {
                        AccountMenuLink(
                            title: "Activity",
                            detail: "Who did what across messages, calls, automations, and settings.",
                            systemImage: "clock.arrow.circlepath",
                            route: .activity(category: AuditCategory.all.rawValue)
                        )
                    }

                    if session.can(Permission.userManage) {
                        AccountMenuLink(
                            title: "Team",
                            detail: "Who has access, what their role allows, and pending invitations.",
                            systemImage: "person.2.badge.gearshape",
                            route: .team
                        )
                    }

                    // Voluntary, and reachable without anything having gone
                    // wrong first. The forced-rotation screen in RootView shows
                    // the same form when the server insists, but nobody can
                    // reach that one on purpose, so before this row existed
                    // there was no way to change a password from the phone at
                    // all.
                    AccountMenuLink(
                        title: "Password",
                        detail: "Change the password you sign in with.",
                        systemImage: "key.fill",
                        route: .password
                    )

                    AccountMenuLink(
                        title: "Settings",
                        detail: "Connection, notifications, and how the app behaves.",
                        systemImage: "gearshape",
                        route: .settings
                    )
                }

                Section {
                    // The ONLY call site of `SessionModel.signOut()` in the
                    // app, and it is an explicit tap on a destructive button.
                    //
                    // `signOut()` disables Telnyx push and wipes the Keychain,
                    // and the VoIP answer path reads the SIP credentials from
                    // that Keychain synchronously. Nothing automatic may reach
                    // this: not a 401, not a failed session restore, not
                    // ACCOUNT_DISABLED, not SESSION_STALE. Those all stop at
                    // the "signed out — tap to sign in" banner instead.
                    Button(role: .destructive) {
                        // Sign-out waits for the push-disable acknowledgement,
                        // so guard against a double tap.
                        isSigningOut = true
                        Task { @MainActor in
                            await session.signOut()
                            isSigningOut = false
                            dismiss()
                        }
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .font(.system(size: 18))
                                .frame(width: 28)
                            Text("Sign out").font(.body.weight(.semibold))
                            Spacer()
                            if isSigningOut { ProgressView() }
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(isSigningOut)
                } footer: {
                    Text("Signing out removes this iPhone's calling credentials, so it stops ringing for incoming calls until you sign in again.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: AppRoute.self) { route in
                accountDestination(route)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        router.dismissAccount()
                        dismiss()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func accountDestination(_ route: AppRoute) -> some View {
        switch route {
        case .assistant:
            if AssistantAccess.isPermitted(for: session.currentUser) {
                AssistantView()
            } else {
                EmptyView()
            }
        case .referrals:
            ReferralsView()
                .assistantNavigationDestination(.referrals)
        case .activity(let category):
            ActivityLogView(category: AuditCategory(rawValue: category) ?? .all)
        case .team:
            TeamView()
        case .password:
            ChangePasswordView(mode: .voluntary)
        case .settings:
            SettingsView()
                .assistantNavigationDestination(.settings)
        case .accountSettings:
            AccountSettingsView()
        case .appearanceSettings:
            AppearanceSettingsView()
        case .notificationSettings:
            NotificationSettingsView()
        case .securitySettings:
            SecuritySettingsView()
        case .messagingCallingSettings:
            MessagingCallingSettingsView()
        case .advancedSettings:
            AdvancedSettingsView()
        case .diagnostics:
            DiagnosticsView()
        case .help:
            HelpSettingsView()
        case .about:
            AboutSettingsView()
        default:
            EmptyView()
        }
    }
}

private struct AccountHeader: View {
    let user: AuthUser?

    var body: some View {
        HStack(spacing: 14) {
            ZStack {
                Circle().fill(ViciTheme.avatarFill)
                if let initials = AccountIdentity.initials(for: user) {
                    Text(initials).font(.title3.bold()).foregroundStyle(ViciTheme.onAvatar)
                } else {
                    Image(systemName: "person.fill").font(.title3).foregroundStyle(ViciTheme.onAvatar)
                }
            }
            .frame(width: 52, height: 52)

            VStack(alignment: .leading, spacing: 3) {
                Text(AccountIdentity.name(for: user)).font(.headline)
                Text(AccountIdentity.subtitle(for: user))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let user, let email = user.email, !email.isEmpty {
                    Text(RoleCatalog.label(user.role))
                        .font(.caption2)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Color(.tertiarySystemFill))
                        .clipShape(Capsule())
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
    }
}

/// A deliberately large row. These were previously buried inside a Settings
/// list among a dozen read-only diagnostic rows.
private struct AccountMenuLink: View {
    let title: String
    let detail: String
    let systemImage: String
    let route: AppRoute

    var body: some View {
        NavigationLink(value: route) {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 18))
                    .foregroundStyle(ViciTheme.tint)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.body.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 6)
        }
    }
}
