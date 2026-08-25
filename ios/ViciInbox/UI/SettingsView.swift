import AVFAudio
import SwiftUI

/// Client-facing settings. Provider and transport diagnostics live one level
/// deeper under Advanced so the primary screen describes outcomes rather than
/// implementation details.
struct SettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel
    @ObservedObject private var assistantPreferences = AssistantPreferences.shared

    /// Says what the row will show rather than naming the feature twice.
    private var assistantDetail: String {
        assistantPreferences.isEnabled ? "Voice, speaking rate and appearance" : "Off on this iPhone"
    }

    var body: some View {
        List {
            Section {
                SettingsLink(title: "Account",
                             detail: session.currentUser?.name ?? "Shared team login",
                             symbol: "person.crop.circle",
                             route: .accountSettings)
                SettingsLink(title: "Appearance",
                             detail: appearance.preference.title,
                             symbol: appearance.preference.symbol,
                             route: .appearanceSettings)
                SettingsLink(title: "Notifications",
                             detail: "Choose which alerts reach this phone",
                             symbol: "bell.badge.fill",
                             route: .notificationSettings)
                SettingsLink(title: "Assistant",
                             detail: assistantDetail,
                             symbol: "sparkles",
                             route: .assistantSettings)
            }

            Section {
                if session.can(Permission.userManage) {
                    SettingsLink(title: "Team",
                                 detail: "Members, roles and invitations",
                                 symbol: "person.2.badge.gearshape",
                                 route: .team)
                }
                SettingsLink(title: "Security",
                             detail: "Password and session access",
                             symbol: "lock.shield.fill",
                             route: .securitySettings)
                SettingsLink(title: "Messaging & Calling",
                             detail: session.voiceStatusText,
                             symbol: "message.and.waveform.fill",
                             route: .messagingCallingSettings)
            }

            Section {
                SettingsLink(title: "Advanced",
                             detail: "Connection diagnostics",
                             symbol: "stethoscope",
                             route: .advancedSettings)
                SettingsLink(title: "Help",
                             detail: "App Tour and message guides",
                             symbol: "questionmark.circle.fill",
                             route: .help)
                SettingsLink(title: "About",
                             detail: "Version and build information",
                             symbol: "info.circle.fill",
                             route: .about)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SettingsLink: View {
    let title: String
    let detail: String
    let symbol: String
    let route: AppRoute

    var body: some View {
        NavigationLink(value: route) {
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

struct AccountSettingsView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel

    /// Names where the time zone came from rather than only what it is. An
    /// account silently running on the device's zone looks identical to one
    /// that was deliberately set, and the difference decides whether a
    /// timestamp means what the reader thinks it means.
    private var timeZoneFooter: String {
        switch appearance.timeZoneSource {
        case .account:
            return "Timestamps across the app are shown in this zone. It is saved to your account, so it follows you to a new iPhone."
        case .workspaceDefault:
            return "This is the workspace default. Choose your own zone to override it on this account."
        case .device:
            return "Taken from this iPhone because your account has no zone set. Choose one to make it stick across devices."
        }
    }

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

                // Gated on a named account because PATCH /api/users/me answers
                // 409 LEGACY_USER_IMMUTABLE for the shared team login: two
                // people share that identity and neither gets to set the
                // other's clock.
                Section {
                    NavigationLink {
                        TimeZonePickerView()
                    } label: {
                        LabeledContent("Time zone", value: appearance.effectiveTimeZone.identifier)
                    }
                } header: {
                    Text("Time zone")
                } footer: {
                    Text(timeZoneFooter)
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

struct AppearanceSettingsView: View {
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

/// The notification screen.
///
/// ═══════════════════════════════════════════════════════════════════════════
/// THREE RULES, AND EACH EXISTS BECAUSE THE OBVIOUS ALTERNATIVE IS WORSE.
///
///   1. PER CATEGORY, AND NO APP LEVEL MASTER SWITCH. iOS already owns the
///      master switch. A second one creates three states to reconcile and one
///      genuinely bad failure mode: this screen reading On while iOS silently
///      drops everything. Somebody who wants all of it off has a place to do
///      that and it is not here.
///
///   2. THE OS STATE IS SHOWN HONESTLY AND THE TOGGLES ARE NOT GREYED OUT. When
///      authorization is missing, a banner says so plainly and offers a route
///      straight to this app's Notifications pane in iOS Settings. Disabling
///      the switches would be the intuitive move and it is wrong: the
///      preference is stored on the ACCOUNT, it still matters, and it takes
///      effect the moment permission comes back. Greying it out throws away a
///      real answer because of a temporary condition.
///
///   3. THE OS STATE IS RE-READ ON EVERY `scenePhase == .active`, not only at
///      launch. Permission can be revoked in iOS Settings while this app is
///      backgrounded and there is NO callback for it. Caching the answer as a
///      proxy would guarantee the screen is wrong exactly when it matters.
/// ═══════════════════════════════════════════════════════════════════════════
///
/// SUPPRESSION IS SERVER SIDE. There is no client-side filter for an alert
/// push: if the backend sends one, iOS shows it whatever this screen says. A
/// toggle here is a request to the server, and `lib/apns-notify.js` is what
/// actually stops the push. Nothing in this file hides a delivered
/// notification and calls that "off".
///
/// COPY RULE: no em dashes. Two short sentences instead.
struct NotificationSettingsView: View {
    @ObservedObject private var notifications = MessageNotificationManager.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var settings: NotificationSettings = .unavailable
    @State private var isLoading = true
    @State private var savingCategory: NotificationCategory?
    @State private var saveError: String?

    var body: some View {
        List {
            authorizationSection
            categoriesSection
            digestSection
            callsSection
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        // Rule 3. There is no callback when permission changes, so the only
        // reliable moment to ask is when the screen comes back to the front.
        .onChange(of: scenePhase) { phase in
            guard phase == .active else { return }
            Task { await notifications.refreshAuthorizationStatus() }
        }
    }

    // MARK: - Sections

    @ViewBuilder
    private var authorizationSection: some View {
        if let banner = authorization.banner {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Label(banner.title, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.orange)
                    Text(banner.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(banner.action) {
                        if authorization == .notDetermined {
                            Task { await notifications.enableAndSync() }
                        } else {
                            notifications.openSystemSettings()
                        }
                    }
                    .font(.subheadline.weight(.semibold))
                }
                .padding(.vertical, 4)
            } footer: {
                // Said explicitly, because the intuitive reading of a warning
                // banner is "these switches are broken", and they are not.
                Text("Your choices below are saved to your account either way. They take effect as soon as iOS allows notifications again.")
            }
        }
    }

    private var categoriesSection: some View {
        Section {
            if isLoading && settings.categories.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading your settings").foregroundStyle(.secondary)
                }
            } else {
                ForEach(settings.rows) { row in
                    if let category = row.category {
                        toggle(for: category, row: row)
                    }
                }
            }
        } header: {
            Text("What to tell me about")
        } footer: {
            Text(categoriesFooter)
        }
    }

    @ViewBuilder
    private var digestSection: some View {
        if let digest = settings.digest {
            Section {
                Text(digest.summary(timeZone: settings.resolvedTimeZone))
                    .font(.footnote)
                if let explanation = digest.silenceExplanation {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let zone = settings.timeZone {
                    LabeledContent("Your timezone", value: zone)
                        .font(.footnote)
                }
            } header: {
                Text("Daily summary")
            } footer: {
                // The read-only timezone pre-empts the one support question
                // this feature is guaranteed to generate, and makes the London
                // and Miami difference visible rather than magical.
                Text("The summary arrives in the morning, in your account's timezone, and only on a day when something moved enough to matter. Change your timezone on your Account.")
            }
        }
    }

    private var callsSection: some View {
        Section {
            LabeledContent("Incoming calls", value: "Enabled while signed in")
        } header: {
            Text("Calls")
        } footer: {
            Text("Incoming calls use the iPhone calling system and follow your Focus and Do Not Disturb settings. This app cannot silence them and does not try to.")
        }
    }

    // MARK: - One row

    private func toggle(for category: NotificationCategory,
                        row: NotificationCategoryDescriptor) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Toggle(isOn: binding(for: category)) {
                HStack(spacing: 11) {
                    Image(systemName: category.symbol)
                        .foregroundStyle(ViciTheme.tint)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    Text(row.label).font(.body)
                }
            }
            // Rule 2: never disabled because of the OS state. Only while its
            // own write is in flight, and only that one row.
            .disabled(savingCategory == category || !settings.available)
            Text(row.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 35)
        }
        .padding(.vertical, 2)
    }

    /// Optimistic, and it puts the switch back if the write fails.
    ///
    /// A toggle that animates to the new position and then silently does not
    /// save is the exact failure this feature exists to avoid, so the setter
    /// moves it, awaits the server, and moves it back with a visible reason if
    /// the server refused.
    private func binding(for category: NotificationCategory) -> Binding<Bool> {
        Binding(
            get: { settings.preferences[category] },
            set: { newValue in
                let previous = settings.preferences[category]
                var optimistic = settings.preferences
                optimistic[category] = newValue
                settings = NotificationSettings(preferences: optimistic,
                                                categories: settings.categories,
                                                available: settings.available,
                                                digest: settings.digest,
                                                timeZone: settings.timeZone)
                Task { await save(category, enabled: newValue, revertTo: previous) }
            }
        )
    }

    // MARK: - Loading and saving

    private var authorization: NotificationAuthorizationState {
        switch notifications.authorizationStatus {
        case .authorized: return .authorized
        case .denied: return .denied
        case .notDetermined: return .notDetermined
        case .provisional: return .provisional
        case .ephemeral: return .ephemeral
        @unknown default: return .unknown
        }
    }

    private var categoriesFooter: String {
        if let saveError { return saveError }
        if !settings.available {
            return "These settings cannot be saved on this server yet. Ask an admin to finish the update."
        }
        return "Your choices are saved to your account, so they follow you to a new iPhone."
    }

    private func load() async {
        isLoading = true
        await notifications.refreshAuthorizationStatus()
        settings = await APIClient.shared.loadNotificationSettings()
        isLoading = false
    }

    private func save(_ category: NotificationCategory,
                      enabled: Bool,
                      revertTo previous: Bool) async {
        savingCategory = category
        saveError = nil
        do {
            settings = try await APIClient.shared.updateNotificationSetting(category, enabled: enabled)
        } catch {
            var reverted = settings.preferences
            reverted[category] = previous
            settings = NotificationSettings(preferences: reverted,
                                            categories: settings.categories,
                                            available: settings.available,
                                            digest: settings.digest,
                                            timeZone: settings.timeZone)
            saveError = "That change was not saved. \(error.localizedDescription)"
        }
        savingCategory = nil
    }
}

struct SecuritySettingsView: View {
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

struct MessagingCallingSettingsView: View {
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

struct AdvancedSettingsView: View {
    var body: some View {
        List {
            NavigationLink(value: AppRoute.diagnostics) {
                Label("Diagnostics", systemImage: "waveform.path.ecg")
            }
        }
        .navigationTitle("Advanced")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct DiagnosticsView: View {
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

struct HelpSettingsView: View {
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

struct AboutSettingsView: View {
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

// MARK: - Time zone picker

/// Choose the zone every timestamp in the app is rendered in.
///
/// The list comes from `GET /api/users/me/timezones` rather than from
/// `TimeZone.knownTimeZoneIdentifiers`, so what can be picked is exactly what
/// the server will accept. A device-built list would eventually offer a zone
/// the PATCH refuses, and the error would arrive after the tap.
///
/// This sets a DISPLAY zone. It has no bearing on campaign quiet hours, which
/// are enforced against the business time zone in SQL. The footer says so,
/// because the two are easy to confuse and confusing them is how a partner in
/// Miami would silently move the sending window five hours.
private struct TimeZonePickerView: View {
    @EnvironmentObject private var session: SessionModel
    @EnvironmentObject private var appearance: AppearanceModel
    @Environment(\.dismiss) private var dismiss

    @State private var catalogue: TimeZoneCatalogue?
    @State private var loadError: String?
    @State private var search = ""
    @State private var saving: String?
    @State private var saveError: String?

    /// The identifier currently stored on the account, or nil when the account
    /// has none and the device's zone is standing in. Distinct from
    /// `appearance.effectiveTimeZone`, which always resolves to something.
    private var storedIdentifier: String? {
        guard appearance.usesAccountTimeZone else { return nil }
        return appearance.accountTimeZoneIdentifier
    }

    var body: some View {
        List {
            if let saveError {
                Section {
                    Label(saveError, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Offered first because it is the one choice that is not in the
            // catalogue: clearing is not picking a zone, it is returning the
            // account to the documented fallback.
            if storedIdentifier != nil && search.isEmpty {
                Section {
                    Button {
                        Task { await save(nil) }
                    } label: {
                        HStack {
                            Text("Use this iPhone's time zone")
                            Spacer()
                            if saving == Self.clearSentinel {
                                ProgressView()
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                    .disabled(saving != nil)
                } footer: {
                    Text("Clears the zone saved on your account. Timestamps then follow whichever device you are on.")
                }
            }

            if let catalogue {
                if search.isEmpty {
                    ForEach(catalogue.groups) { group in
                        Section(group.region) {
                            ForEach(group.zones) { zone in row(for: zone) }
                        }
                    }
                } else {
                    let hits = catalogue.allZones.filter { $0.matches(search) }
                    if hits.isEmpty {
                        Section {
                            Text("No time zone matches \"\(search)\".")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        // Flat, not grouped: a filtered list rebuilding its
                        // region headings for one hit each would be mostly
                        // headings. The region is on each row instead.
                        Section {
                            ForEach(hits) { zone in row(for: zone, showingRegion: true) }
                        }
                    }
                }
            } else if let loadError {
                Section {
                    Label(loadError, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try again") { Task { await load() } }
                }
            } else {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading time zones").foregroundStyle(.secondary)
                    }
                }
            }
        }
        .searchable(text: $search, prompt: "City, region or abbreviation")
        .navigationTitle("Time zone")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    /// `saving` holds the identifier being written so only the tapped row shows
    /// a spinner. Clearing has no identifier, so it gets a sentinel that cannot
    /// collide with an IANA name.
    private static let clearSentinel = "\u{0}clear"

    @ViewBuilder
    private func row(for zone: TimeZoneOption, showingRegion: Bool = false) -> some View {
        Button {
            Task { await save(zone.id) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(zone.label)
                    Text(showingRegion ? "\(zone.region) · \(zone.detail)" : zone.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if saving == zone.id {
                    ProgressView()
                } else if zone.id == storedIdentifier {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(ViciTheme.tint)
                        .accessibilityLabel("Selected")
                }
            }
            // Without this the row is only hittable across the text, and a tap
            // in the gap before the checkmark does nothing.
            .contentShape(Rectangle())
        }
        .foregroundStyle(.primary)
        .disabled(saving != nil)
        .accessibilityAddTraits(zone.id == storedIdentifier ? .isSelected : [])
    }

    private func load() async {
        loadError = nil
        do {
            catalogue = try await APIClient.shared.loadTimeZoneCatalogue()
        } catch {
            catalogue = nil
            loadError = error.localizedDescription
        }
    }

    private func save(_ identifier: String?) async {
        guard saving == nil else { return }
        saving = identifier ?? Self.clearSentinel
        saveError = nil
        defer { saving = nil }
        do {
            _ = try await APIClient.shared.updateTimeZone(identifier)
            // Re-read rather than assume. The server stores the canonical
            // spelling, so what came back may differ in case from what was
            // sent, and every timestamp in the app is about to be rendered
            // from it.
            await session.reloadCurrentUser()
            appearance.applyAccountTimeZone(
                session.currentUser?.timeZone,
                isDefault: session.currentUser?.timeZoneIsDefault ?? false
            )
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
    }
}

// MARK: - Assistant settings

/// Everything the operator can decide about the assistant on this device.
///
/// The server's `ASSISTANT_ENABLED` is the pilot kill switch and is not shown
/// here, because it is not this person's decision. The toggle below is one
/// person opting out on one phone. Off in either place means off, and the
/// footer says which is which rather than leaving somebody to wonder why a
/// switch that reads On produced nothing.
struct AssistantSettingsView: View {
    @ObservedObject private var preferences = AssistantPreferences.shared

    var body: some View {
        List {
            Section {
                Toggle("Assistant", isOn: $preferences.isEnabled)
            } footer: {
                Text(preferences.isEnabled
                     ? "Ask about the business by voice and jump straight to what you asked for. It reads your data and drafts nothing, and it cannot send a message."
                     : "The assistant is off on this iPhone. Nothing else changes.")
            }

            if preferences.isEnabled {
                Section {
                    Toggle("Thorough answers", isOn: $preferences.thoroughAnswers)
                } header: {
                    Text("Answers")
                } footer: {
                    Text(preferences.thoroughAnswers
                         ? "Looks things up more than once when a question needs it, so answers about several things at once come back complete. Takes a few seconds longer."
                         : "Answers after a single look up. Faster, and it will tell you when a question needed more than that rather than guessing.")
                }
                voiceSection
                appearanceSection
            }
        }
        .navigationTitle("Assistant")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var voiceSection: some View {
        Section {
            NavigationLink {
                AssistantVoiceLibraryView()
            } label: {
                LabeledContent("Voice", value: preferences.pinnedVoiceName ?? "Elise")
            }

            Picker("Speaking rate", selection: $preferences.speakingRate) {
                ForEach(AssistantSpeakingRate.allCases) { rate in
                    Text(rate.label).tag(rate)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Voice")
        } footer: {
            Text("Search hundreds of voices and hear each one before you choose. Answers are spoken in the cloud, so this needs a connection. Without one the assistant falls back to the iPhone's built in voice.")
        }
    }

    private var appearanceSection: some View {
        Section {
            Picker("Colour", selection: $preferences.orbTint) {
                ForEach(AssistantOrbTint.allCases) { tint in
                    Text(tint.label).tag(tint)
                }
            }
            Picker("Size", selection: $preferences.orbSize) {
                ForEach(AssistantOrbSize.allCases) { size in
                    Text(size.label).tag(size)
                }
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Appearance")
        } footer: {
            Text("Warning and error colours never change, so a problem always looks like a problem.")
        }
    }

    /// The picker stores nil for automatic, which is why the tags are optional.
    private var voiceBinding: Binding<String?> {
        Binding(
            get: { preferences.pinnedVoiceIdentifier },
            set: { preferences.pinnedVoiceIdentifier = $0 }
        )
    }
}


// MARK: - Assistant voice library

/// Search the voice library and hear one before choosing it.
///
/// WHY THESE VOICES AND NOT THE BUILT IN ONES
///   The owner's verdict on the synthetic presets was that they sound
///   generated, and he was right. These are cloned from real people, and
///   `usedBy` is the honest signal for which held up in real products: a voice
///   thousands of builders shipped is one that survived contact with listeners.
///
/// PREVIEW COSTS NOTHING
///   Each voice ships a sample clip, so auditioning plays that rather than
///   synthesising fresh audio. Browsing forty voices would otherwise burn a
///   meaningful slice of the monthly character budget on nobody listening
///   properly.
struct AssistantVoiceLibraryView: View {
    @ObservedObject private var preferences = AssistantPreferences.shared
    @StateObject private var model = AssistantVoiceLibraryModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                Picker("Voice", selection: $model.gender) {
                    Text("Anyone").tag("")
                    Text("Female").tag("female")
                    Text("Male").tag("male")
                }
                .pickerStyle(.segmented)
                Picker("Accent", selection: $model.accent) {
                    Text("Any accent").tag("")
                    Text("British").tag("british")
                    Text("American").tag("american")
                    Text("Australian").tag("australian")
                }
            }

            if preferences.pinnedVoiceIdentifier != nil {
                Section {
                    Button("Use the default voice") {
                        preferences.pinnedVoiceIdentifier = nil
                        preferences.pinnedVoiceName = nil
                        dismiss()
                    }
                }
            }

            if let message = model.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote)
                        .foregroundStyle(ViciTheme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Try again") { Task { await model.load() } }
                }
            } else if model.isLoading && model.voices.isEmpty {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Finding voices").foregroundStyle(.secondary)
                    }
                }
            } else if model.voices.isEmpty {
                Section {
                    Text("No voices match that. Try a different search.")
                        .foregroundStyle(.secondary)
                }
            } else {
                Section {
                    ForEach(model.voices) { voice in
                        row(voice)
                    }
                } footer: {
                    Text("Tap to hear a voice. Tap Use to make it the assistant's.")
                }
            }
        }
        .searchable(text: $model.query, prompt: "Search voices")
        .navigationTitle("Assistant voice")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .onChange(of: model.gender) { _ in Task { await model.load() } }
        .onChange(of: model.accent) { _ in Task { await model.load() } }
        .onSubmit(of: .search) { Task { await model.load() } }
        .onDisappear { model.stopPreview() }
    }

    @ViewBuilder
    private func row(_ voice: AssistantVoiceOption) -> some View {
        HStack(spacing: 12) {
            Button {
                model.preview(voice)
            } label: {
                Image(systemName: model.previewingID == voice.id ? "stop.circle.fill" : "play.circle.fill")
                    .font(.title2)
                    .foregroundStyle(ViciTheme.tint)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.previewingID == voice.id ? "Stop preview" : "Preview \(voice.name)")

            VStack(alignment: .leading, spacing: 2) {
                Text(voice.name).font(.body)
                Text(voice.subtitle).font(.caption).foregroundStyle(.secondary)
            }

            Spacer()

            if preferences.pinnedVoiceIdentifier == voice.id {
                Image(systemName: "checkmark")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(ViciTheme.tint)
                    .accessibilityLabel("Selected")
            } else {
                Button("Use") {
                    preferences.pinnedVoiceIdentifier = voice.id
                    preferences.pinnedVoiceName = voice.name
                    model.stopPreview()
                    dismiss()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }
}

@MainActor
private final class AssistantVoiceLibraryModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var query = ""
    @Published var gender = "female"
    @Published var accent = ""
    @Published private(set) var voices: [AssistantVoiceOption] = []
    @Published private(set) var isLoading = false
    @Published private(set) var previewingID: String?
    @Published var errorMessage: String?

    private var player: AVAudioPlayer?
    private var loadTask: Task<Void, Never>?

    func load() async {
        // Newest search wins. Typing four characters must not leave four
        // requests racing to decide what is on screen.
        loadTask?.cancel()
        isLoading = true
        errorMessage = nil
        let task = Task { [query, gender, accent] in
            do {
                let result = try await APIClient.shared.assistantVoices(
                    query: query.isEmpty ? nil : query,
                    gender: gender.isEmpty ? nil : gender,
                    accent: accent.isEmpty ? nil : accent
                )
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.voices = result.voices
                    self.isLoading = false
                }
            } catch {
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.errorMessage = error.localizedDescription
                    self.isLoading = false
                }
            }
        }
        loadTask = task
        await task.value
    }

    func preview(_ voice: AssistantVoiceOption) {
        if previewingID == voice.id { stopPreview(); return }
        stopPreview()
        guard let raw = voice.previewUrl, let url = URL(string: raw) else { return }
        previewingID = voice.id
        Task { [weak self] in
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                guard let self, self.previewingID == voice.id else { return }
                await MainActor.run {
                    self.player = try? AVAudioPlayer(data: data)
                    self.player?.delegate = self
                    self.player?.play()
                }
            } catch {
                await MainActor.run { self?.previewingID = nil }
            }
        }
    }

    func stopPreview() {
        player?.stop()
        player = nil
        previewingID = nil
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in self.previewingID = nil }
    }
}
