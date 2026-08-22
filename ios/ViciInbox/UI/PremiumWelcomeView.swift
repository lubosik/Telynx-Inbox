import SwiftUI

struct PremiumWelcomeView: View {
    let firstName: String
    let dismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var rotation = Angle.degrees(0)

    var body: some View {
        ZStack {
            (reduceTransparency ? ViciTheme.loginGround : ViciTheme.loginGround.opacity(0.97))
                .ignoresSafeArea()

            edgeGlow
                .allowsHitTesting(false)

            VStack(spacing: 18) {
                Spacer()
                Image(systemName: "message.and.waveform.fill")
                    .font(.system(size: 42, weight: .medium))
                    .foregroundStyle(ViciTheme.tint)
                    .accessibilityHidden(true)

                VStack(spacing: 7) {
                    Text(firstName.isEmpty ? "Welcome to Vici Inbox" : "Welcome, \(firstName)")
                        .font(.system(.largeTitle, design: .rounded, weight: .bold))
                        .multilineTextAlignment(.center)
                    Text("Customer conversations, calls and revenue opportunities are ready in one place.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 30)

                Spacer()

                Button("Continue", action: dismiss)
                    .buttonStyle(.borderedProminent)
                    .tint(ViciTheme.tint)
                    .controlSize(.large)
                    .padding(.horizontal, 28)
                    .padding(.bottom, 36)
            }
        }
        .accessibilityElement(children: .contain)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.linear(duration: 4).repeatForever(autoreverses: false)) {
                rotation = .degrees(360)
            }
        }
    }

    private var edgeGlow: some View {
        GeometryReader { geometry in
            let shape = RoundedRectangle(cornerRadius: 36, style: .continuous)
            ZStack {
                shape
                    .stroke(
                        AngularGradient(
                            colors: [
                                ViciTheme.tint,
                                ViciTheme.bloomMint,
                                Color.blue.opacity(0.8),
                                Color.purple.opacity(0.68),
                                Color.orange.opacity(0.58),
                                ViciTheme.tint
                            ],
                            center: .center,
                            angle: rotation
                        ),
                        lineWidth: reduceTransparency ? 3 : 4
                    )
                if !reduceTransparency {
                    shape
                        .stroke(
                            AngularGradient(
                                colors: [ViciTheme.bloomMint, Color.blue, Color.purple, ViciTheme.tint],
                                center: .center,
                                angle: rotation
                            ),
                            lineWidth: 5
                        )
                        .blur(radius: 12)
                        .opacity(0.42)
                }
            }
            .padding(10)
            .frame(width: geometry.size.width, height: geometry.size.height)
        }
        .ignoresSafeArea()
    }
}
