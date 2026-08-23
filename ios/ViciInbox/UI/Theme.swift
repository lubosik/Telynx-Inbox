import SwiftUI
import UIKit

/// The Vici Peptides brand palette — the single source of truth for colour in
/// this app. Do not scatter hex literals through views; add a semantic token
/// here instead.
///
/// Brand kit (from vicipeptides.com):
///   Ink        #1A1A1A — near-black, the wordmark colour
///   Ink 2      #2B2B2B — secondary body text
///   Deep teal  #138177 — primary accent: buttons, tint, active states
///   Teal dark  #0C7C6B — pressed / darker variant
///   Mint       #81D8D0 — light accent, badges, highlights
///   Mint mid   #7EC7BC
///   Pale mint  #E4F5F2 / #F0FAF8 — surfaces, inbound bubbles
///   Greige     #CFC7BC — avatars, neutral fills
///   Warm brown #76644C — secondary text on greige
///   White      #FFFFFF — ground
///
/// Every token is a dynamic colour. Deep teal and near-black ink read well on
/// white but not on black, so dark mode substitutes lifted variants of the
/// same hue rather than repainting surfaces. System semantic colours remain
/// the base for large surfaces; brand colour is applied as accent.
enum ViciTheme {

    // MARK: - Core brand tokens

    /// Interactive tint: links, icons, the send button, pinned markers, the
    /// sign-in button. Deep teal in light mode; brand mint-mid in dark mode so
    /// tinted glyphs and text stay legible on black. Matches the AccentColor
    /// asset, which handles the tab bar and navigation automatically.
    static let tint = dynamic(light: 0x138177, dark: 0x7EC7BC)

    /// Filled teal surface: primary filled controls (the dialler call button)
    /// and the outbound message bubble. Barely lifted in dark mode so the fill
    /// separates from a black background; white foreground text works on both.
    static let tealFill = dynamic(light: 0x138177, dark: 0x14897D)

    /// Outbound message bubble — same fill as `tealFill`, named for intent.
    static let bubbleOut = tealFill

    /// Inbound message bubble: pale mint over white, a teal-tinted dark
    /// surface over black. Foreground stays `.primary` on both.
    static let bubbleIn = dynamic(light: 0xE4F5F2, dark: 0x2A3835)

    /// Soft mint fill for large passive accents (the in-call avatar circle).
    /// Quieter than `bubbleIn` in dark mode so it reads as a glow, not a card.
    static let mintFill = dynamic(light: 0xE4F5F2, dark: 0x1E3B36)

    /// Contact avatar circles — warm greige from the brand kit, muted to an
    /// earthy dark neutral in dark mode.
    static let avatarFill = dynamic(light: 0xCFC7BC, dark: 0x4A443B)

    /// Foreground drawn on top of `avatarFill` (avatar initials).
    static let onAvatar = dynamic(light: 0x76644C, dark: 0xD9CDBA)

    /// The wordmark ink — near-black on white, near-white on black.
    static let ink = dynamic(light: 0x1A1A1A, dark: 0xF2F2F0)

    /// Secondary ink for the lockup subline ("PEPTIDES").
    static let inkSecondary = dynamic(light: 0x2B2B2B, dark: 0xC9C9C6)

    // MARK: - State tokens (deliberately not teal)

    /// Positive/ready states: connection dot, completed calls, sent counters.
    /// A green that harmonises with the teal without becoming it — success
    /// must still read as success.
    static let success = dynamic(light: 0x2E8757, dark: 0x4FB183)

    /// Waiting/attention states (connecting dot, pending counters).
    static let warning = Color(.systemOrange)

    /// Destructive/error: end-call, failed sends, missed calls, cancel.
    /// Stays a system red so errors never look like brand accent.
    static let destructive = Color(.systemRed)

    // MARK: - Login "soft mint light drift" palette

    /// Fixed bloom hues for the login backdrop. Drawn over `loginGround` at
    /// low opacity by the Canvas, so they need no dark variants of their own.
    static let bloomMint    = Color(hex: 0x81D8D0)
    static let bloomMintMid = Color(hex: 0x7EC7BC)
    static let bloomTeal    = Color(hex: 0x138177)

    /// Ground behind the login blooms: brand white by day, a near-black with
    /// the faintest green cast in dark mode.
    static let loginGround = dynamic(light: 0xFFFFFF, dark: 0x101413)

    // MARK: - Plumbing

    /// Trait-aware colour from two sRGB hex values.
    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
        })
    }
}

extension Color {
    /// Fixed (non-adaptive) colour from an sRGB hex value like 0x138177.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

private extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// A "Done" button for the keyboard accessory bar.
///
/// Multi-line `TextEditor` treats Return as a newline, which is correct for a
/// message body and leaves no way to dismiss the keyboard. Without this the
/// keyboard covers the wizard's bottom toolbar and the Next button becomes
/// unreachable — you can finish typing and still not move on.
///
/// Liquid Glass where the OS has it, a tinted capsule everywhere else. Both
/// read as the same control; only the material differs.
struct KeyboardDoneButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label("Done", systemImage: "keyboard.chevron.compact.down")
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
        }
        .accessibilityLabel("Dismiss keyboard")
        .accessibilityHint("Hides the keyboard so you can continue")
        .modifier(KeyboardDoneBackground())
    }
}

private struct KeyboardDoneBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            // A concrete Capsule() rather than the `.capsule` shorthand, and no
            // `.interactive()`: this file cannot be type-checked locally (SwiftUI
            // needs the iOS SDK), so it sticks to the narrowest API surface that
            // is certain to resolve.
            content
                .glassEffect(.regular.tint(ViciTheme.tint.opacity(0.22)), in: Capsule())
                .foregroundStyle(ViciTheme.tint)
        } else {
            content
                .background(ViciTheme.tint.opacity(0.14), in: Capsule())
                .foregroundStyle(ViciTheme.tint)
        }
    }
}
