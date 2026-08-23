import SwiftUI
import UIKit

/// The measuring and drawing half of the first-run tour.
///
/// The tour used to guess where its subject was: it divided the screen width by
/// the tab count and hoped, and for anything that was not a tab it drew a
/// rounded rectangle a third of the way down the screen. The result was a box
/// over the middle of a message row while the card talked about the Growth tab.
/// Everything here exists so a highlight is either the real, currently
/// laid-out frame of the thing being described, or nothing at all.
///
/// Frames arrive from two places, because the two kinds of target live in two
/// different worlds:
///
///  * Ordinary SwiftUI content publishes its own frame through
///    `OnboardingTargetFrameKey`, applied with `.onboardingTarget(_:)`.
///  * The tab bar and the navigation bar are UIKit chrome. `.tabItem` content
///    becomes a `UITabBarItem` and toolbar content is hosted by
///    `UINavigationBar`, so neither can carry a SwiftUI `GeometryReader`.
///    `OnboardingChromeProbe` reads those frames from the live view hierarchy
///    instead.
///
/// Both feed `OnboardingSpotlightResolver`, which refuses anything implausible
/// rather than pointing at it.

// MARK: - SwiftUI target publication

/// Frames of onboarding targets in `.global` coordinates.
struct OnboardingTargetFrameKey: PreferenceKey {
    static var defaultValue: [OnboardingTarget: CGRect] { [:] }

    static func reduce(value: inout [OnboardingTarget: CGRect],
                       nextValue: () -> [OnboardingTarget: CGRect]) {
        value.merge(nextValue()) { _, newer in newer }
    }
}

extension View {
    /// Registers this view as the thing the tour points at for `target`.
    ///
    /// The frame is read from the laid-out view, not computed, and it
    /// disappears from the preference the moment the view leaves the hierarchy
    /// — which is what stops a scrolled-away or unmounted target from being
    /// highlighted at a stale position.
    func onboardingTarget(_ target: OnboardingTarget) -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(key: OnboardingTargetFrameKey.self,
                                       value: [target: proxy.frame(in: .global)])
            }
            .accessibilityHidden(true)
        )
    }
}

// MARK: - UIKit chrome frames

/// Tab bar and navigation bar frames, in window coordinates.
///
/// Not a preference, because the views being measured are not SwiftUI views.
final class OnboardingChromeFrames: ObservableObject {
    @Published private(set) var frames: [OnboardingTarget: CGRect] = [:]

    func update(_ next: [OnboardingTarget: CGRect]) {
        guard next != frames else { return }
        frames = next
    }
}

/// A zero-sized, non-interactive probe that reads the live UIKit chrome.
///
/// It re-measures on a slow timer rather than once, because the frames it wants
/// change without SwiftUI telling it: the tab bar animates in, a navigation bar
/// swaps when the selected tab changes, and the device can rotate. The timer is
/// only alive while the tour is on screen.
struct OnboardingChromeProbe: UIViewRepresentable {
    /// Left to right, matching the order the tabs are declared in.
    let tabOrder: [OnboardingTarget]
    let onMeasure: ([OnboardingTarget: CGRect]) -> Void

    func makeUIView(context: Context) -> OnboardingChromeProbeView {
        let view = OnboardingChromeProbeView()
        view.tabOrder = tabOrder
        view.onMeasure = onMeasure
        return view
    }

    func updateUIView(_ uiView: OnboardingChromeProbeView, context: Context) {
        uiView.tabOrder = tabOrder
        uiView.onMeasure = onMeasure
        uiView.scheduleMeasurement()
    }
}

final class OnboardingChromeProbeView: UIView {
    var tabOrder: [OnboardingTarget] = []
    var onMeasure: (([OnboardingTarget: CGRect]) -> Void)?

    private var timer: Timer?
    private var lastReported: [OnboardingTarget: CGRect] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) {
        fatalError("OnboardingChromeProbeView is created in code only")
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { stop() } else { start() }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scheduleMeasurement()
    }

    deinit { timer?.invalidate() }

    /// Deferred to the next runloop turn on purpose: `updateUIView` and
    /// `layoutSubviews` both run inside a SwiftUI update, and publishing a
    /// change from there is what produces "Publishing changes from within view
    /// updates" and an unstable layout.
    func scheduleMeasurement() {
        DispatchQueue.main.async { [weak self] in self?.measure() }
    }

    private func start() {
        guard timer == nil else { return }
        measure()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.measure()
        }
        // `.common` so measurement keeps up while a list underneath is
        // scrolling or a tab change is animating.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func measure() {
        guard let window else { return }
        var frames: [OnboardingTarget: CGRect] = [:]

        if let tabBar = Self.firstVisibleDescendant(UITabBar.self, in: window) {
            frames.merge(tabItemFrames(in: tabBar, window: window)) { _, newer in newer }
        }

        if let navigationBar = Self.firstVisibleDescendant(UINavigationBar.self, in: window),
           let account = accountButtonFrame(in: navigationBar, window: window) {
            frames[.account] = account
        }

        guard frames != lastReported else { return }
        lastReported = frames
        onMeasure?(frames)
    }

    private func tabItemFrames(in tabBar: UITabBar, window: UIWindow) -> [OnboardingTarget: CGRect] {
        guard !tabOrder.isEmpty else { return [:] }
        let barRect = tabBar.convert(tabBar.bounds, to: window)
        guard barRect.width > 1, barRect.height > 1 else { return [:] }

        // A tab bar button is a `UIControl`; the background and the separator
        // are not. No private class name is referenced.
        let buttons = tabBar.subviews
            .filter { $0 is UIControl && $0.bounds.width > 8 && $0.bounds.height > 8 }
            .sorted { $0.frame.minX < $1.frame.minX }

        var frames: [OnboardingTarget: CGRect] = [:]
        if buttons.count == tabOrder.count {
            for (offset, target) in tabOrder.enumerated() {
                let button = buttons[offset]
                frames[target] = button.convert(button.bounds, to: window).insetBy(dx: -2, dy: -2)
            }
            return frames
        }

        // The count did not line up, which means the hierarchy is mid-change or
        // laid out in a way this does not recognise. The bar's own frame is
        // still real, and a tab bar divides it evenly, so an even division is a
        // measured fallback rather than the old whole-screen guess.
        let itemWidth = barRect.width / CGFloat(tabOrder.count)
        let itemHeight = min(barRect.height, 52)
        for (offset, target) in tabOrder.enumerated() {
            frames[target] = CGRect(x: barRect.minX + CGFloat(offset) * itemWidth,
                                    y: barRect.minY,
                                    width: itemWidth,
                                    height: itemHeight)
                .insetBy(dx: 6, dy: 0)
        }
        return frames
    }

    /// The account avatar, derived from the real navigation bar.
    ///
    /// It is derived rather than read directly: the button is SwiftUI toolbar
    /// content hosted inside `UINavigationBar`, so it is reachable neither by a
    /// preference nor by any public UIKit accessor. What is public is the bar's
    /// laid-out frame and its leading layout margin, which is exactly where the
    /// leading bar button item starts. The avatar is a 30pt circle
    /// (`AccountAvatarButton`), padded here to a 44pt tap-sized square.
    ///
    /// With a large navigation title the bar grows downwards and the buttons
    /// stay in the standard 44pt strip at the top, so the strip is measured
    /// from `minY` rather than from the centre.
    private func accountButtonFrame(in navigationBar: UINavigationBar,
                                    window: UIWindow) -> CGRect? {
        let barRect = navigationBar.convert(navigationBar.bounds, to: window)
        guard barRect.width > 44, barRect.height > 20 else { return nil }
        let leading = max(navigationBar.directionalLayoutMargins.leading, 16)
        let side: CGFloat = 44
        let avatar: CGFloat = 30
        let centreX = barRect.minX + leading + avatar / 2
        let centreY = barRect.minY + min(barRect.height, 44) / 2
        return CGRect(x: centreX - side / 2,
                      y: centreY - side / 2,
                      width: side,
                      height: side)
    }

    private static func firstVisibleDescendant<T: UIView>(_ type: T.Type, in root: UIView) -> T? {
        guard isOnScreen(root) else { return nil }
        if let match = root as? T { return match }
        // Reversed so the frontmost candidate wins when more than one is
        // installed, such as a navigation bar behind a presented one.
        for subview in root.subviews.reversed() {
            if let found = firstVisibleDescendant(type, in: subview) { return found }
        }
        return nil
    }

    private static func isOnScreen(_ view: UIView) -> Bool {
        !view.isHidden && view.alpha > 0.01 && view.bounds.width > 1 && view.bounds.height > 1
    }
}

// MARK: - Resolution

/// Turns a step's target into the rectangle to cut out of the dimming, or into
/// `nil`.
///
/// `nil` is a first-class answer. A tour that shows a plain centred card is
/// merely plain; a tour that draws a lit box over an unrelated message row
/// looks broken, and that is the bug this replaces.
enum OnboardingSpotlightResolver {

    /// Ordered candidates for one target: the precise thing first, then the tab
    /// that contains it. Step 4 talks about campaign review, so it prefers the
    /// Campaigns segment and settles for the Growth tab; step 6 prefers the
    /// revenue breakdown and settles for the Analytics tab.
    static func candidates(for target: OnboardingTarget) -> [OnboardingTarget] {
        switch target {
        case .campaigns: return [.campaigns, .growth]
        case .revenueAttribution: return [.revenueAttribution, .analytics]
        default: return [target]
        }
    }

    /// - Parameters:
    ///   - contentFrames: frames published by `.onboardingTarget(_:)`.
    ///   - chromeFrames: frames measured from the tab bar and navigation bar.
    ///   - bounds: the overlay's own rectangle, in the same global space.
    /// - Returns: a rectangle in the overlay's local coordinates, or `nil`.
    static func spotlight(for target: OnboardingTarget,
                          contentFrames: [OnboardingTarget: CGRect],
                          chromeFrames: [OnboardingTarget: CGRect],
                          bounds: CGRect) -> CGRect? {
        for candidate in candidates(for: target) {
            guard let global = contentFrames[candidate] ?? chromeFrames[candidate],
                  isUsable(global, within: bounds) else { continue }
            return global.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
        }
        return nil
    }

    static func isUsable(_ rect: CGRect, within bounds: CGRect) -> Bool {
        guard rect.origin.x.isFinite, rect.origin.y.isFinite,
              rect.width.isFinite, rect.height.isFinite,
              rect.width >= 16, rect.height >= 16,
              bounds.width > 1, bounds.height > 1 else { return false }
        // Something taller than most of the screen is a container, not a
        // subject, and cutting it out would dim nothing.
        guard rect.height <= bounds.height * 0.7 else { return false }
        let visible = rect.intersection(bounds)
        guard !visible.isNull, !visible.isEmpty else { return false }
        // Mostly scrolled off screen counts as absent.
        return visible.width >= rect.width * 0.8 && visible.height >= rect.height * 0.8
    }
}

// MARK: - Drawing

/// The dimming layer with the target punched out of it.
///
/// `eoFill` on a path that contains the whole rectangle and then the hole is
/// the reliable way to do this: no compositing group, no blend mode, and it
/// behaves the same whether or not the layer is inside a `.drawingGroup`.
struct OnboardingSpotlightShape: Shape {
    var hole: CGRect
    var cornerRadius: CGFloat

    var animatableData: AnimatablePair<AnimatablePair<CGFloat, CGFloat>,
                                       AnimatablePair<CGFloat, CGFloat>> {
        get {
            AnimatablePair(AnimatablePair(hole.origin.x, hole.origin.y),
                           AnimatablePair(hole.size.width, hole.size.height))
        }
        set {
            hole = CGRect(x: newValue.first.first,
                          y: newValue.first.second,
                          width: newValue.second.first,
                          height: newValue.second.second)
        }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path(rect)
        guard hole.width > 0, hole.height > 0 else { return path }
        path.addPath(Path(roundedRect: hole, cornerRadius: cornerRadius, style: .continuous))
        return path
    }
}

/// A short line into a solid triangle. Deliberately blunt: at tab-bar size an
/// elaborate curve reads as decoration, and the point of the thing is to say
/// "that one".
struct OnboardingArrowIndicator: View {
    enum Direction: Hashable {
        /// The subject is above the card.
        case up
        /// The subject is below the card.
        case down
    }

    let direction: Direction
    let length: CGFloat
    let color: Color

    private var headHeight: CGFloat { min(12, max(6, length * 0.5)) }
    private var shaftHeight: CGFloat { max(0, length - headHeight) }

    var body: some View {
        VStack(spacing: 0) {
            if direction == .up {
                OnboardingArrowHead(direction: .up).fill(color).frame(width: 17, height: headHeight)
            }
            Rectangle().fill(color).frame(width: 2.5, height: shaftHeight)
            if direction == .down {
                OnboardingArrowHead(direction: .down).fill(color).frame(width: 17, height: headHeight)
            }
        }
        .accessibilityHidden(true)
    }
}

struct OnboardingArrowHead: Shape {
    let direction: OnboardingArrowIndicator.Direction

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch direction {
        case .up:
            path.move(to: CGPoint(x: rect.midX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        case .down:
            path.move(to: CGPoint(x: rect.midX, y: rect.maxY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        }
        path.closeSubpath()
        return path
    }
}
