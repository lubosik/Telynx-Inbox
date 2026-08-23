import Foundation

/// The time-of-day rule behind the Scheduled appearance option.
///
/// Deliberately Foundation-only and free of any view or observable machinery,
/// because it is the one part of the feature with arithmetic that can be wrong
/// in a way nobody notices for months: the window normally crosses midnight,
/// and the naive `now >= darkStart && now < lightStart` test is dark for zero
/// minutes of every day when it does. This file is in the `swiftc -typecheck`
/// list in AGENTS.md, so unlike the SwiftUI half of the feature it is really
/// compiled before it is pushed.
///
/// Times are stored as minutes from local midnight rather than as `Date`s. A
/// `Date` would pin the rule to the day it was chosen, and a `DateComponents`
/// would carry a calendar and a timezone that must not be captured — the
/// timezone is resolved fresh on every evaluation so a person who flies
/// somewhere gets that place's evening.
struct AppearanceSchedule: Equatable, Hashable {
    /// Minutes from midnight at which the app turns dark. 19:00 by default:
    /// after the working day, before the evening.
    var darkStartMinutes: Int

    /// Minutes from midnight at which the app returns to light. 07:00.
    var lightStartMinutes: Int

    static let minutesPerDay = 24 * 60

    static let `default` = AppearanceSchedule(darkStartMinutes: 19 * 60,
                                              lightStartMinutes: 7 * 60)

    init(darkStartMinutes: Int, lightStartMinutes: Int) {
        self.darkStartMinutes = AppearanceSchedule.normalised(darkStartMinutes)
        self.lightStartMinutes = AppearanceSchedule.normalised(lightStartMinutes)
    }

    /// Wraps rather than clamps. A stored value can only be out of range if it
    /// was written by a different build, and wrapping keeps 25:00 meaning 01:00
    /// instead of collapsing every bad value onto the same endpoint.
    static func normalised(_ minutes: Int) -> Int {
        let wrapped = minutes % minutesPerDay
        return wrapped < 0 ? wrapped + minutesPerDay : wrapped
    }

    /// A schedule with both ends on the same minute has no dark window and no
    /// light window. It is treated as "never dark" rather than as an error, and
    /// the settings screen says so instead of silently doing nothing.
    var isDegenerate: Bool { darkStartMinutes == lightStartMinutes }

    /// Whether the dark window runs through midnight, which is the normal case.
    var crossesMidnight: Bool { darkStartMinutes > lightStartMinutes }

    // MARK: - Evaluation

    /// The rule, on minutes alone, so it can be exercised without a clock.
    ///
    /// Two shapes, and both are real:
    ///   dark 19:00 -> light 07:00   crosses midnight, dark when at-or-after
    ///                               19:00 OR before 07:00
    ///   dark 01:00 -> light 09:00   a night worker, entirely within one day,
    ///                               dark when at-or-after 01:00 AND before 09:00
    static func isDark(atMinuteOfDay minute: Int,
                       schedule: AppearanceSchedule) -> Bool {
        guard !schedule.isDegenerate else { return false }
        let now = normalised(minute)
        if schedule.crossesMidnight {
            return now >= schedule.darkStartMinutes || now < schedule.lightStartMinutes
        }
        return now >= schedule.darkStartMinutes && now < schedule.lightStartMinutes
    }

    func isDark(at date: Date, timeZone: TimeZone) -> Bool {
        AppearanceSchedule.isDark(atMinuteOfDay: AppearanceSchedule.minuteOfDay(for: date,
                                                                               timeZone: timeZone),
                                  schedule: self)
    }

    /// Minute of the local day, in the given timezone.
    static func minuteOfDay(for date: Date, timeZone: TimeZone) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return normalised((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
    }

    // MARK: - Re-evaluation timing

    /// When the appearance would next change, so the app can wake exactly then
    /// instead of polling.
    ///
    /// Returns nil for a degenerate schedule, which never changes. The result
    /// is always strictly in the future: a boundary that is happening in this
    /// very minute has already been applied, and returning it would schedule a
    /// timer with a non-positive interval that fires immediately and forever.
    ///
    /// Built by asking `Calendar` for the next matching wall-clock time rather
    /// than by adding seconds, so a DST jump does not put the boundary an hour
    /// out. On the day a clock skips over the boundary hour entirely,
    /// `nextDate` lands on the following occurrence, which is correct: that
    /// boundary genuinely did not happen locally.
    func nextChange(after date: Date, timeZone: TimeZone) -> Date? {
        guard !isDegenerate else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone

        let candidates = [darkStartMinutes, lightStartMinutes].compactMap { minutes -> Date? in
            var components = DateComponents()
            components.hour = minutes / 60
            components.minute = minutes % 60
            components.second = 0
            return calendar.nextDate(after: date,
                                     matching: components,
                                     matchingPolicy: .nextTime,
                                     repeatedTimePolicy: .first,
                                     direction: .forward)
        }
        return candidates.min()
    }

    // MARK: - Display

    /// A `Date` on an arbitrary fixed day carrying only this time of day, for
    /// binding to a `DatePicker` with `displayedComponents: .hourAndMinute`.
    ///
    /// The reference day is a plain fixed date rather than "today", so the
    /// binding does not silently change identity at midnight while the settings
    /// screen is open.
    static func referenceDate(forMinuteOfDay minutes: Int, timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.year = 2001
        components.month = 1
        components.day = 1
        components.hour = normalised(minutes) / 60
        components.minute = normalised(minutes) % 60
        return calendar.date(from: components) ?? Date(timeIntervalSinceReferenceDate: 0)
    }
}

/// Where the schedule's idea of "evening" comes from.
///
/// The account timezone is preferred so the whole team's app agrees with the
/// workspace's working day, and the device timezone is the fallback whenever
/// the server has not sent one or has sent something Foundation does not know.
/// There is no third state: an unresolvable identifier degrades to the device
/// rather than to UTC, because UTC is wrong for everybody and the device is at
/// worst wrong for a traveller.
enum AppearanceTimeZoneResolver {
    static func resolve(accountIdentifier: String?) -> TimeZone {
        guard let accountIdentifier,
              !accountIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let zone = TimeZone(identifier: accountIdentifier.trimmingCharacters(in: .whitespacesAndNewlines))
        else { return TimeZone.current }
        return zone
    }

    /// Whether the account's identifier was actually usable, so the settings
    /// screen can name the source instead of implying an account timezone it
    /// did not get.
    static func usesAccountTimeZone(accountIdentifier: String?) -> Bool {
        guard let accountIdentifier,
              !accountIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return false }
        return TimeZone(identifier: accountIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)) != nil
    }
}
