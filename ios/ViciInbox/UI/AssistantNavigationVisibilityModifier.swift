import SwiftUI

/// Completes an Assistant navigation only when SwiftUI has materialised the
/// exact typed destination. This modifier carries no content and performs no
/// navigation itself.
private struct AssistantNavigationVisibilityModifier: ViewModifier {
    let route: AppRoute

    func body(content: Content) -> some View {
        content.onAppear {
            AssistantNavigationCoordinator.shared.destinationDidBecomeVisible(route)
        }
    }
}

extension View {
    func assistantNavigationDestination(_ route: AppRoute) -> some View {
        modifier(AssistantNavigationVisibilityModifier(route: route))
    }
}
