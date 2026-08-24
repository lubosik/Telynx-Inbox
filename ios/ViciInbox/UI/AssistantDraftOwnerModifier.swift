import SwiftUI

/// Connects one mutable view to the global programmatic-navigation guard.
/// The registry receives only an opaque token, source and dirty boolean. Draft
/// content stays in the owning view and is cleared by `discard` locally.
private struct AssistantDraftOwnerModifier: ViewModifier {
    let source: AssistantDraftSource
    let isDirty: Bool
    let discard: () -> Void

    @ObservedObject private var registry = AssistantUnsavedDraftRegistry.shared
    @State private var token: AssistantDraftToken?

    func body(content: Content) -> some View {
        content
            .onAppear { registerIfNeeded() }
            .onChange(of: isDirty) { dirty in
                guard let token else { return }
                registry.setDirty(dirty, for: token)
            }
            .onChange(of: registry.discardRequest?.id) { _ in
                handleDiscardIfNeeded()
            }
            .onDisappear {
                guard let token else { return }
                registry.unregister(token)
                self.token = nil
            }
    }

    private func registerIfNeeded() {
        guard token == nil else { return }
        let registered = registry.register(source: source)
        token = registered
        registry.setDirty(isDirty, for: registered)
        handleDiscardIfNeeded()
    }

    private func handleDiscardIfNeeded() {
        guard let token,
              let request = registry.discardRequest,
              request.tokenIDs.contains(token.id) else { return }
        let requestID = request.id
        // Check immediately before touching owner state. A cancelled or
        // replaced request must never erase a draft.
        guard registry.discardRequest?.id == requestID else { return }
        discard()
        // Dismissal may unregister synchronously. If the owner is still alive,
        // acknowledge only the exact request that caused its local clear.
        guard registry.discardRequest?.id == requestID else { return }
        registry.acknowledgeDiscard(for: token, requestID: requestID)
    }
}

extension View {
    func assistantDraftOwner(source: AssistantDraftSource,
                             isDirty: Bool,
                             onDiscard: @escaping () -> Void) -> some View {
        modifier(AssistantDraftOwnerModifier(source: source,
                                             isDirty: isDirty,
                                             discard: onDiscard))
    }
}
