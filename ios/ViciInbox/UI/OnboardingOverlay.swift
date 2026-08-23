import SwiftUI
import UIKit

/// The first-run tour's coach card, the dimming, and the highlight.
///
/// The rule this view is built around: the highlight is the real frame of the
/// thing the card is talking about, or there is no highlight. Measurement lives
/// in `OnboardingSpotlight.swift`; this view only places what it is given.
///
/// `contentFrames` arrives from `overlayPreferenceValue` at the tab-view root,
/// so it is already collected after layout and needs no state of its own. The
/// UIKit chrome cannot be collected that way and is measured by the probe held
/// here, alive only while the tour is.
struct OnboardingOverlay: View {
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @StateObject private var chrome = OnboardingChromeFrames()
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Frames published by `.onboardingTarget(_:)`, in global coordinates.
    let contentFrames: [OnboardingTarget: CGRect]

    /// The tab bar's targets, left to right. Used to map measured tab buttons
    /// onto the tabs this account can actually see.
    let visibleTabs: [OnboardingTarget]

    var body: some View {
        GeometryReader { geometry in
            content(geometry: geometry)
        }
        .ignoresSafeArea()
        .zIndex(100)
    }

    @ViewBuilder
    private func content(geometry: GeometryProxy) -> some View {
        let size = geometry.size
        let step = onboarding.currentStep
        let spotlight = step.flatMap { current in
            OnboardingSpotlightResolver.spotlight(
                for: current.target,
                contentFrames: contentFrames,
                chromeFrames: chrome.frames,
                bounds: geometry.frame(in: .global)
            )
        }

        ZStack(alignment: .topLeading) {
            probe

            if let step {
                dimming(spotlight: spotlight)
                if let spotlight {
                    highlightRing(spotlight)
                }
                coach(step: step, spotlight: spotlight, size: size)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: step?.id)
        // Deliberately NOT animated on `spotlight`.
        //
        // The spotlight frame arrives asynchronously: OnboardingChromeProbe
        // measures the real tab bar on a repeating timer, so for up to a
        // quarter of a second after a step appears the placement is still
        // `centred` and the card then moves to `.top` or `.bottom`. Animating
        // that transition looks smooth and costs the first tap, because
        // SwiftUI hit-tests an animating view at its FINAL geometry: a tap on
        // the visible Next button during the ~470ms window lands on empty
        // space, and the person taps again. That is one of the three
        // two-taps reported from the field.
        //
        // Moving instantly is the right trade. The jump is over before a hand
        // arrives, and a control that is where it looks is worth more than a
        // transition nobody asked for. The step change is still animated,
        // which is the movement that actually reads as motion.
        .onChange(of: step?.id) { _ in announceCurrentStep() }
        .onAppear { announceCurrentStep() }
    }

    private var probe: some View {
        OnboardingChromeProbe(tabOrder: visibleTabs) { measured in
            chrome.update(measured)
        }
        .frame(width: 1, height: 1)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    // MARK: - Dimming and highlight

    /// The whole screen darkened, with the subject cut back out of it.
    ///
    /// The dimming absorbs every touch, including inside the cutout: the tour
    /// is describing the interface, not handing it over, and a stray tap on the
    /// tab underneath would move the app out from under the step.
    private func dimming(spotlight: CGRect?) -> some View {
        OnboardingSpotlightShape(hole: spotlight ?? .zero, cornerRadius: spotlightCornerRadius)
            .fill(Color.black.opacity(reduceTransparency ? 0.8 : 0.6),
                  style: FillStyle(eoFill: true))
            .contentShape(Rectangle())
            .onTapGesture { /* Absorbed on purpose. Use Back, Next or Skip. */ }
            .accessibilityHidden(true)
    }

    private func highlightRing(_ spotlight: CGRect) -> some View {
        RoundedRectangle(cornerRadius: spotlightCornerRadius, style: .continuous)
            .strokeBorder(ViciTheme.tint, lineWidth: 2.5)
            .frame(width: spotlight.width, height: spotlight.height)
            .position(x: spotlight.midX, y: spotlight.midY)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private var spotlightCornerRadius: CGFloat { 14 }

    // MARK: - Coach card placement

    private struct CoachPlacement {
        var alignment: Alignment
        var topPadding: CGFloat
        var bottomPadding: CGFloat
        var arrow: OnboardingArrowIndicator.Direction?
        var arrowLength: CGFloat
        var arrowOffsetX: CGFloat
    }

    private func coach(step: OnboardingStep, spotlight: CGRect?, size: CGSize) -> some View {
        let cardWidth = min(max(size.width - 36, 240), 360)
        let placement = placement(spotlight: spotlight, size: size, cardWidth: cardWidth)

        return VStack(spacing: 0) {
            if placement.arrow == .up {
                arrow(.up, placement: placement, cardWidth: cardWidth)
            }
            card(step: step).frame(width: cardWidth)
            if placement.arrow == .down {
                arrow(.down, placement: placement, cardWidth: cardWidth)
            }
        }
        .padding(.top, placement.topPadding)
        .padding(.bottom, placement.bottomPadding)
        .frame(width: size.width, height: size.height, alignment: placement.alignment)
    }

    private func arrow(_ direction: OnboardingArrowIndicator.Direction,
                       placement: CoachPlacement,
                       cardWidth: CGFloat) -> some View {
        OnboardingArrowIndicator(direction: direction,
                                 length: placement.arrowLength,
                                 color: ViciTheme.tint)
            .frame(width: cardWidth, alignment: .center)
            .offset(x: placement.arrowOffsetX)
    }

    /// Puts the card on whichever side of the subject has room for it, and
    /// points the arrow back at the subject from that side.
    ///
    /// The flip is driven by available space rather than by a fixed rule, which
    /// is what makes an edge target work: the tab bar leaves nothing below it,
    /// so the card goes above and the arrow points down; the account button
    /// sits under the status bar, so the card goes below and the arrow points
    /// up. When neither side can hold a card the card is centred and the arrow
    /// is dropped, because a 30pt arrow crossing a card is worse than none.
    private func placement(spotlight: CGRect?, size: CGSize, cardWidth: CGFloat) -> CoachPlacement {
        let centred = CoachPlacement(alignment: .center,
                                     topPadding: 0,
                                     bottomPadding: 0,
                                     arrow: nil,
                                     arrowLength: 0,
                                     arrowOffsetX: 0)
        guard let spotlight else { return centred }

        let gap: CGFloat = 20
        let minimumRoom: CGFloat = 190
        let spaceAbove = spotlight.minY
        let spaceBelow = size.height - spotlight.maxY

        // Keep the arrow over the card even when the subject is at a screen
        // edge, such as the leftmost tab or the account button.
        let limit = max(0, cardWidth / 2 - 24)
        let offsetX = min(max(spotlight.midX - size.width / 2, -limit), limit)

        let preferBelow = spaceBelow >= spaceAbove
        if preferBelow, spaceBelow >= minimumRoom {
            return CoachPlacement(alignment: .top,
                                  topPadding: spotlight.maxY,
                                  bottomPadding: 16,
                                  arrow: .up,
                                  arrowLength: gap,
                                  arrowOffsetX: offsetX)
        }
        if !preferBelow, spaceAbove >= minimumRoom {
            return CoachPlacement(alignment: .bottom,
                                  topPadding: 16,
                                  bottomPadding: size.height - spotlight.minY,
                                  arrow: .down,
                                  arrowLength: gap,
                                  arrowOffsetX: offsetX)
        }
        if spaceBelow >= minimumRoom {
            return CoachPlacement(alignment: .top,
                                  topPadding: spotlight.maxY,
                                  bottomPadding: 16,
                                  arrow: .up,
                                  arrowLength: gap,
                                  arrowOffsetX: offsetX)
        }
        if spaceAbove >= minimumRoom {
            return CoachPlacement(alignment: .bottom,
                                  topPadding: 16,
                                  bottomPadding: size.height - spotlight.minY,
                                  arrow: .down,
                                  arrowLength: gap,
                                  arrowOffsetX: offsetX)
        }
        return centred
    }

    // MARK: - The card

    private func card(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(onboarding.progressText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("Step \(onboarding.progressText)")
                Spacer()
                Button("Skip Tour") { onboarding.skip() }
                    .font(.caption.weight(.semibold))
            }

            Text(step.title).font(.headline)
            Text(step.detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack {
                if onboarding.canGoBack {
                    Button("Back") { onboarding.back() }
                        .buttonStyle(.bordered)
                }
                Spacer()
                Button(onboarding.isLastStep ? "Finish" : "Next") { onboarding.next() }
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
            }
        }
        .padding(18)
        // Always fully opaque. The card is the only readable text on a dimmed
        // screen, so it never becomes a translucency effect.
        .background(Color(.systemBackground),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(ViciTheme.tint.opacity(reduceTransparency ? 0.6 : 0.28))
        }
        .shadow(color: .black.opacity(0.24), radius: 18, y: 8)
        // VoiceOver stays inside the card. Without this the dimming and the
        // highlight are just more elements to swipe past, and the app behind
        // them stays reachable while a modal tour is running.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel(step.title)
    }

    private func announceCurrentStep() {
        guard let step = onboarding.currentStep else { return }
        UIAccessibility.post(notification: .screenChanged,
                             argument: "\(step.title). \(step.detail)")
    }
}
