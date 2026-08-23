import SwiftUI

/// Client-facing settings. Provider and transport diagnostics live one level
/// deeper under Advanced so the primary screen describes outcomes rather than
/// implementation details.
struct SettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel

    var body: some View {
        List {
            Section {
                SettingsLink(title: "Account",
                             detail: session.currentUser?.name ?? "Shared team login",
                             symbol: "person.crop.circle") {
                    AccountSettingsView()
                }
                SettingsLink(title: "Appearance",
                             detail: appearance.preference.title,
                             symbol: appearance.preference.symbol) {
                    AppearanceSettingsView()
                }
                SettingsLink(title: "Notifications",
                             detail: "Messages, calls and business alerts",
                             symbol: "bell.badge.fill") {
                    NotificationSettingsView()
                }
            }

            Section {
                if session.can(Permission.userManage) {
                    SettingsLink(title: "Team",
                                 detail: "Members, roles and invitations",
                                 symbol: "person.2.badge.gearshape") {
                        TeamView()
                    }
                }
                SettingsLink(title: "Security",
                             detail: "Password and session access",
                             symbol: "lock.shield.fill") {
                    SecuritySettingsView()
                }
                SettingsLink(title: "Messaging & Calling",
                             detail: session.voiceStatusText,
                             symbol: "message.and.waveform.fill") {
                    MessagingCallingSettingsView()
                }
            }

            Section {
                SettingsLink(title: "Advanced",
                             detail: "Connection diagnostics",
                             symbol: "stethoscope") {
                    AdvancedSettingsView()
                }
                SettingsLink(title: "Help",
                             detail: "App Tour and message guides",
                             symbol: "questionmark.circle.fill") {
                    HelpSettingsView()
                }
                SettingsLink(title: "About",
                             detail: "Version and build information",
                             symbol: "info.circle.fill") {
                    AboutSettingsView()
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsLink<Destination: View>: View {
    let title: String
    let detail: String
    let symbol: String
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        NavigationLink(destination: destination) {
            HStack(spacing: 13) {
                Image(systemName: symbol)
                    .foregroundStyle(ViciTheme.tint)
                    .frame(width: 26)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

private struct AccountSettingsView: View {
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        List {
            Section("Signed in") {
                if let user = session.currentUser {
                    LabeledContent("Name", value: user.name)
                    if let email = user.email, !email.isEmpty {
                        LabeledContent("Email", value: email)
                    } else {
                        LabeledContent("Email", value: "Not available")
                    }
                    if let pending = user.pendingEmail {
                        LabeledContent("Pending", value: pending)
                            .foregroundStyle(ViciTheme.warning)
                            .accessibilityHint("Waiting for confirmation from this address")
                    }
                    LabeledContent("Role", value: RoleCatalog.label(user.role))
                } else {
                    Text("Shared team login")
                    Text("Use a named account for personal settings and first-time guidance.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if session.currentUser != nil {
                Section {
                    NavigationLink("Change name or email") { ProfileEditorView() }
                } footer: {
                    Text("Your name changes immediately. A new email address has to be confirmed from that address before it takes effect.")
                }
            }

            Section {
                NavigationLink("Change password") { ChangePasswordView(mode: .voluntary) }
                if session.can(Permission.userManage) {
                    NavigationLink("Manage team") { TeamView() }
                }
            }
        }
        .navigationTitle("Account")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AppearanceSettingsView: View {
    @EnvironmentObject private var appearance: AppearanceModel

    var body: some View {
        List {
            Section {
                ForEach(AppearancePreference.allCases) { option in
                    Button {
                        appearance.preference = option
                    } label: {
                        HStack(spacing: 12) {
                            Label(option.title, systemImage: option.symbol)
                            Spacer()
                            if appearance.preference == option {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(ViciTheme.tint)
                                    .accessibilityLabel("Selected")
                            }
                        }
                        // Without this the row is only hittable across the
                        // label and the checkmark, and a tap in the gap between
                        // them does nothing.
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                    .accessibilityAddTraits(appearance.preference == option ? .isSelected : [])
                }
            } footer: {
                Text("System follows this iPhone's current appearance. Scheduled switches on its own at the times below.")
            }

            if appearance.preference == .scheduled {
                scheduleSection
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var scheduleSection: some View {
        Section {
            DatePicker("Dark from",
                       selection: darkStartBinding,
                       displayedComponents: .hourAndMinute)
            DatePicker("Light from",
                       selection: lightStartBinding,
                       displayedComponents: .hourAndMinute)

            if appearance.schedule.isDegenerate {
                Label("Both times are the same, so the appearance never changes. Move one of them.",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(ViciTheme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                LabeledContent("Right now",
                               value: appearance.isScheduleDark ? "Dark" : "Light")
                if let next = appearance.nextChange {
                    LabeledContent("Changes next", value: nextChangeText(next))
                }
            }

            Button("Reset to 19:00 and 07:00") {
                appearance.resetScheduleToDefault()
            }
            .disabled(appearance.schedule == AppearanceSchedule.default)
        } header: {
            Text("Schedule")
        } footer: {
            Text(timeZoneFooter)
        }
        // The pickers show wall-clock time in the zone the schedule is actually
        // evaluated in. Without this a person whose account timezone differs
        // from their phone's would set 19:00 and watch it switch at some other
        // hour, with nothing on screen explaining why.
        .environment(\.timeZone, appearance.effectiveTimeZone)
    }

    private var darkStartBinding: Binding<Date> {
        Binding(
            get: {
                AppearanceSchedule.referenceDate(forMinuteOfDay: appearance.schedule.darkStartMinutes,
                                                 timeZone: appearance.effectiveTimeZone)
            },
            set: { newValue in
                appearance.setDarkStart(
                    minutes: AppearanceSchedule.minuteOfDay(for: newValue,
                                                            timeZone: appearance.effectiveTimeZone)
                )
            }
        )
    }

    private var lightStartBinding: Binding<Date> {
        Binding(
            get: {
                AppearanceSchedule.referenceDate(forMinuteOfDay: appearance.schedule.lightStartMinutes,
                                                 timeZone: appearance.effectiveTimeZone)
            },
            set: { newValue in
                appearance.setLightStart(
                    minutes: AppearanceSchedule.minuteOfDay(for: newValue,
                                                            timeZone: appearance.effectiveTimeZone)
                )
            }
        )
    }

    private func nextChangeText(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.timeZone = appearance.effectiveTimeZone
        formatter.locale = Locale.current
        formatter.setLocalizedDateFormatFromTemplate("jm")
        return formatter.string(from: date)
    }

    /// Names the source of the times rather than just showing them. A schedule
    /// that quietly runs on a timezone the person is not in is the one failure
    /// of this feature that would be impossible to work out from the screen.
    private var timeZoneFooter: String {
        let identifier = appearance.effectiveTimeZone.identifier
        switch appearance.timeZoneSource {
        case .account:
            return "Times are in your account's timezone, \(identifier)."
        case .workspaceDefault:
            return "Times are in \(identifier), the workspace default. Set your own timezone on your account to use a different one."
        case .device:
            return "Times are in this iPhone's timezone, \(identifier). Your account has no timezone yet, so the device's is used."
        }
    }
}

private struct NotificationSettingsView: View {
    @ObservedObject private var notifications = MessageNotificationManager.shared

    var body: some View {
        List {
            Section("Messages") {
                LabeledContent("Status", value: notifications.statusText)
                if notifications.authorizationStatus == .denied {
                    Button("Open iPhone Settings") { notifications.openSystemSettings() }
                } else if !notifications.isRegisteredWithBackend {
                    Button("Enable notifications") {
                        Task { await notifications.enableAndSync() }
                    }
                }
                if let error = notifications.lastError {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Calls") {
                LabeledContent("Incoming calls", value: "Enabled while signed in")
                Text("Incoming calls use the iPhone calling system and follow Focus and notification settings.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SecuritySettingsView: View {
    var body: some View {
        List {
            Section {
                NavigationLink("Change password") { ChangePasswordView(mode: .voluntary) }
            } footer: {
                Text("Changing your password ends your other signed-in sessions. This iPhone stays connected.")
            }
        }
        .navigationTitle("Security")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct MessagingCallingSettingsView: View {
    @EnvironmentObject private var session: SessionModel

    var body: some View {
        List {
            Section {
                LabeledContent("Calling", value: session.voiceStatusText)
                LabeledContent("Number", value: session.callerNumber.isEmpty
                               ? "Not available"
                               : PhoneFormatter.pretty(session.callerNumber))
                Button("Reconnect calling") { session.refreshConnection() }
            } header: {
                Text("Business line")
            } footer: {
                Text("Reconnect restores the calling connection without signing out or changing stored credentials.")
            }
        }
        .navigationTitle("Messaging & Calling")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AdvancedSettingsView: View {
    var body: some View {
        List {
            NavigationLink {
                DiagnosticsView()
            } label: {
                Label("Diagnostics", systemImage: "waveform.path.ecg")
            }
        }
        .navigationTitle("Advanced")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct DiagnosticsView: View {
    @EnvironmentObject private var session: SessionModel
    @ObservedObject private var notifications = MessageNotificationManager.shared

    var body: some View {
        List {
            Section("Connection summary") {
                LabeledContent("Messaging", value: notifications.isRegisteredWithBackend ? "Connected" : notifications.statusText)
                LabeledContent("Calling", value: session.isVoiceReady ? "Connected" : session.voiceStatusText)
                LabeledContent("Push notifications", value: notifications.statusText)
            }

            // The backend host is deliberately not shown. The three rows above
            // already answer the only question a person here is asking — is it
            // connected — and the hostname is infrastructure detail that every
            // signed-in account, Support agents included, would otherwise see.
            Section("Technical details") {
                LabeledContent("VoIP token", value: TelnyxVoiceManager.shared.pushDiagnostics.hasToken ? "Received" : "Waiting")
                LabeledContent("VoIP registration", value: TelnyxVoiceManager.shared.pushDiagnostics.registeredLogin ? "Registered" : "Not confirmed")
                LabeledContent("VoIP environment", value: TelnyxVoiceManager.shared.pushDiagnostics.environment.capitalized)
                LabeledContent("APNs environment", value: notifications.environment.capitalized)
            }
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct HelpSettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var onboarding: OnboardingCoordinator

    var body: some View {
        List {
            Section {
                Button {
                    onboarding.startManualReplay(for: session.currentUser)
                } label: {
                    Label("Replay App Tour", systemImage: "sparkles.rectangle.stack")
                }
                .disabled(session.currentUser == nil || session.currentUser?.isSharedTeamLogin == true)
            } footer: {
                Text("Replaying the tour does not reset your first-time setup.")
            }

            Section {
                LabeledContent("Queued", value: "Waiting at Telnyx")
                LabeledContent("Sent", value: "Carrier received it")
                LabeledContent("Delivered", value: "Delivery confirmed")
                LabeledContent("Failed", value: "Not delivered")
            } header: {
                Text("Sent message status guide")
            } footer: {
                Text("Delivered confirms carrier or device delivery, not that the recipient read it. SMS and MMS do not provide read receipts.")
            }

            Section("Inbox conversation times") {
                LabeledContent("Example", value: "6 min")
                Text("The time at the right of a conversation shows how long ago its latest message was sent or received.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Help")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AboutSettingsView: View {
    var body: some View {
        List {
            Section("Vici Inbox") {
                LabeledContent("Version", value: version)
                LabeledContent("Build", value: build)
            }
            Section {
                Text("A private customer communications and revenue operations workspace for the Vici team.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "Not available"
    }

    private var build: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "Not available"
    }
}
