import Foundation
import SwiftUI
import UIKit

enum AppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark
    /// Light by day, dark in the evening, on a schedule the person sets.
    ///
    /// A fourth option rather than a modifier on Light or Dark: System already
    /// means "somebody else decides", and this is a different somebody. Keeping
    /// them separate is what lets a person who wants iOS to drive appearance
    /// keep exactly the behaviour they have today.
    case scheduled

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        case .scheduled: return "Scheduled"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        case .scheduled: return "clock.badge.checkmark"
        }
    }

    /// The fixed answer, for the three preferences that have one.
    ///
    /// `scheduled` has no fixed answer and deliberately returns nil here rather
    /// than guessing. Read `AppearanceModel.resolvedColorScheme` instead; it is
    /// the only property that knows what time it is.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        case .scheduled: return nil
        }
    }
}

/// The appearance preference, and — for the scheduled option — the clock that
/// drives it.
///
/// The scheduled option has to keep working while the app is open, not only at
/// launch, so this owns a timer. The timer is a single one-shot armed for the
/// next boundary rather than a repeating minute tick: the boundary time is
/// already known exactly, and a poll that runs 1,440 times a day to change
/// something twice is a battery cost with nothing to show for it.
///
/// Everything is torn down and re-armed whenever an input changes, which
/// includes the four ways the answer can move underneath a running app: the
/// preference changes, the times change, the account timezone arrives or
/// changes, or the device's own clock or timezone changes.
@MainActor
final class AppearanceModel: ObservableObject {
    @Published var preference: AppearancePreference {
        didSet {
            guard preference != oldValue else { return }
            defaults.set(preference.rawValue, forKey: Self.preferenceKey)
            reevaluate()
        }
    }

    /// The wall-clock times behind `.scheduled`.
    @Published var schedule: AppearanceSchedule {
        didSet {
            guard schedule != oldValue else { return }
            defaults.set(schedule.darkStartMinutes, forKey: Self.darkStartKey)
            defaults.set(schedule.lightStartMinutes, forKey: Self.lightStartKey)
            reevaluate()
        }
    }

    /// True while the schedule currently says dark. Published so the settings
    /// screen can show what the rule is doing right now rather than making
    /// somebody wait until the evening to find out whether they set it up
    /// correctly.
    @Published private(set) var isScheduleDark = false

    /// The IANA identifier the signed-in account carries, when the server sends
    /// one. Nil means "use this device's timezone", which is also what an
    /// unrecognised identifier degrades to.
    @Published private(set) var accountTimeZoneIdentifier: String?

    /// True when the identifier above is the server's own fallback rather than
    /// a zone this person picked. The settings footer says which, because a
    /// schedule silently running on somebody else's idea of evening is the one
    /// failure of this feature that could not be worked out from the screen.
    @Published private(set) var accountTimeZoneIsDefault = false

    /// The scheme to hand to `preferredColorScheme`. Nil means "follow iOS".
    var resolvedColorScheme: ColorScheme? {
        switch preference {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        case .scheduled: return isScheduleDark ? .dark : .light
        }
    }

    /// The timezone the schedule is actually being evaluated in.
    var effectiveTimeZone: TimeZone {
        AppearanceTimeZoneResolver.resolve(accountIdentifier: accountTimeZoneIdentifier)
    }

    /// Whether that timezone came from the account or from the device, so the
    /// settings screen can name the source honestly.
    var usesAccountTimeZone: Bool {
        AppearanceTimeZoneResolver.usesAccountTimeZone(accountIdentifier: accountTimeZoneIdentifier)
    }

    /// Where the times are being read: the person's own account setting, the
    /// workspace default the server supplied, or this device.
    enum TimeZoneSource {
        case account
        case workspaceDefault
        case device
    }

    var timeZoneSource: TimeZoneSource {
        guard usesAccountTimeZone else { return .device }
        return accountTimeZoneIsDefault ? .workspaceDefault : .account
    }

    /// When the appearance will next flip, for the settings footer. Nil when
    /// nothing is scheduled or the schedule is degenerate.
    var nextChange: Date? {
        guard preference == .scheduled else { return nil }
        return schedule.nextChange(after: Date(), timeZone: effectiveTimeZone)
    }

    private static let preferenceKey = "vici.appearance.preference"
    private static let darkStartKey = "vici.appearance.schedule.darkStartMinutes"
    private static let lightStartKey = "vici.appearance.schedule.lightStartMinutes"

    private let defaults: UserDefaults
    private var boundaryTimer: Timer?
    private var observers: [NSObjectProtocol] = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        preference = AppearancePreference(
            rawValue: defaults.string(forKey: Self.preferenceKey) ?? ""
        ) ?? .system

        // `object(forKey:)` rather than `integer(forKey:)` so an unset key is
        // distinguishable from a stored 0, which is a legitimate time (midnight).
        let storedDark = defaults.object(forKey: Self.darkStartKey) as? Int
        let storedLight = defaults.object(forKey: Self.lightStartKey) as? Int
        schedule = AppearanceSchedule(
            darkStartMinutes: storedDark ?? AppearanceSchedule.default.darkStartMinutes,
            lightStartMinutes: storedLight ?? AppearanceSchedule.default.lightStartMinutes
        )

        observeSystemChanges()
        reevaluate()
    }

    deinit {
        boundaryTimer?.invalidate()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Inputs

    /// Called when the signed-in identity is loaded or changes.
    ///
    /// Takes the raw identifier rather than a `TimeZone` so the caller does not
    /// have to decide what an unknown one means; that decision belongs to
    /// `AppearanceTimeZoneResolver` and is the same everywhere.
    func applyAccountTimeZone(_ identifier: String?, isDefault: Bool = false) {
        let cleaned = identifier?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalised = (cleaned?.isEmpty ?? true) ? nil : cleaned
        let changed = normalised != accountTimeZoneIdentifier
            || isDefault != accountTimeZoneIsDefault
        guard changed else { return }
        accountTimeZoneIdentifier = normalised
        accountTimeZoneIsDefault = isDefault
        reevaluate()
    }

    func setDarkStart(minutes: Int) {
        schedule = AppearanceSchedule(darkStartMinutes: minutes,
                                      lightStartMinutes: schedule.lightStartMinutes)
    }

    func setLightStart(minutes: Int) {
        schedule = AppearanceSchedule(darkStartMinutes: schedule.darkStartMinutes,
                                      lightStartMinutes: minutes)
    }

    func resetScheduleToDefault() {
        schedule = .default
    }

    /// Re-reads the clock. Safe to call at any time and from anywhere; it does
    /// no work beyond the arithmetic unless the answer actually moved.
    func refresh() {
        reevaluate()
    }

    // MARK: - Evaluation

    private func reevaluate() {
        boundaryTimer?.invalidate()
        boundaryTimer = nil

        guard preference == .scheduled else {
            // Left as it is rather than forced false. Nothing reads it while
            // another preference is selected, and clearing it would make the
            // settings preview flicker every time somebody browses the options.
            return
        }

        let zone = effectiveTimeZone
        let nowIsDark = schedule.isDark(at: Date(), timeZone: zone)
        if nowIsDark != isScheduleDark {
            isScheduleDark = nowIsDark
        }
        armBoundaryTimer(timeZone: zone)
    }

    private func armBoundaryTimer(timeZone: TimeZone) {
        guard let next = schedule.nextChange(after: Date(), timeZone: timeZone) else { return }
        // A one-second cushion, because a timer that fires on the exact second
        // of the boundary can round back to the previous minute and compute the
        // appearance it already has, then re-arm for the same instant.
        let interval = max(1, next.timeIntervalSinceNow + 1)
        let timer = Timer(timeInterval: interval, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.reevaluate() }
        }
        // `.common` so the appearance still flips while a list is being
        // scrolled, which is exactly when somebody is most likely to be looking
        // at the screen.
        RunLoop.main.add(timer, forMode: .common)
        boundaryTimer = timer
    }

    /// The three ways the answer can move without this object being touched.
    ///
    /// A suspended app gets no timer fire, so becoming active must re-evaluate:
    /// the phone can be asleep across the whole evening boundary. The clock and
    /// significant-time notifications cover a manual clock change, a timezone
    /// change from travel, and the DST transition.
    private func observeSystemChanges() {
        let centre = NotificationCenter.default
        let names: [Notification.Name] = [
            UIApplication.didBecomeActiveNotification,
            UIApplication.significantTimeChangeNotification,
            .NSSystemClockDidChange,
            .NSSystemTimeZoneDidChange
        ]
        for name in names {
            let token = centre.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.reevaluate() }
            }
            observers.append(token)
        }
    }
}
