import SwiftUI
import UIKit

struct OnboardingOverlay: View {
    @EnvironmentObject private var onboarding: OnboardingCoordinator
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    let visibleTabs: [OnboardingTarget]

    var body: some View {
        GeometryReader { geometry in
            if let step = onboarding.currentStep {
                let target = targetFrame(for: step.target, in: geometry)
                ZStack {
                    spotlightMask(target: target)
                    coachCard(step: step, target: target, size: geometry.size)
                }
                .ignoresSafeArea()
                .transition(.opacity)
                .accessibilityElement(children: .contain)
                .onChange(of: step.id) { _ in announce(step) }
                .onAppear { announce(step) }
            }
        }
        .zIndex(100)
    }

    private func spotlightMask(target: CGRect) -> some View {
        ZStack {
            Color.black.opacity(reduceTransparency ? 0.72 : 0.58)
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .frame(width: target.width, height: target.height)
                .position(x: target.midX, y: target.midY)
                .blendMode(.destinationOut)
        }
        .compositingGroup()
        .allowsHitTesting(true)
    }

    private func coachCard(step: OnboardingStep, target: CGRect, size: CGSize) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(onboarding.progressText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
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
        .frame(maxWidth: 340)
        .background(reduceTransparency ? Color(.systemBackground) : Color(.systemBackground).opacity(0.96),
                    in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(ViciTheme.tint.opacity(0.28))
        }
        .shadow(color: .black.opacity(0.24), radius: 18, y: 8)
        .position(x: size.width / 2,
                  y: target.midY > size.height / 2 ? max(155, target.minY - 135) : min(size.height - 170, target.maxY + 145))
        .padding(.horizontal, 18)
    }

    private func targetFrame(for target: OnboardingTarget,
                             in geometry: GeometryProxy) -> CGRect {
        let size = geometry.size
        if target == .account {
            return CGRect(x: 12, y: max(48, geometry.safeAreaInsets.top + 4), width: 58, height: 58)
        }

        let tabTarget: OnboardingTarget
        switch target {
        case .campaigns:
            tabTarget = .growth
        case .revenueAttribution:
            tabTarget = .analytics
        default:
            tabTarget = target
        }
        guard let index = visibleTabs.firstIndex(of: tabTarget), !visibleTabs.isEmpty else {
            return CGRect(x: 16, y: size.height / 3, width: size.width - 32, height: 110)
        }
        let width = size.width / CGFloat(visibleTabs.count)
        return CGRect(x: CGFloat(index) * width + 5,
                      y: size.height - max(86, geometry.safeAreaInsets.bottom + 60),
                      width: width - 10,
                      height: 74)
    }

    private func announce(_ step: OnboardingStep) {
        UIAccessibility.post(notification: .screenChanged,
                             argument: "\(step.title). \(step.detail)")
    }
}
