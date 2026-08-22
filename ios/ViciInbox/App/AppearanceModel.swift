import Foundation
import SwiftUI

enum AppearancePreference: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var title: String {
        switch self {
        case .system: return "System"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }

    var symbol: String {
        switch self {
        case .system: return "circle.lefthalf.filled"
        case .light: return "sun.max.fill"
        case .dark: return "moon.fill"
        }
    }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}

@MainActor
final class AppearanceModel: ObservableObject {
    @Published var preference: AppearancePreference {
        didSet { defaults.set(preference.rawValue, forKey: Self.defaultsKey) }
    }

    private static let defaultsKey = "vici.appearance.preference"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        preference = AppearancePreference(
            rawValue: defaults.string(forKey: Self.defaultsKey) ?? ""
        ) ?? .system
    }
}
