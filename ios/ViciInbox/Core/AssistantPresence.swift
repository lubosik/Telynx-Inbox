import Foundation
import Combine

/// Whether a conversation with the assistant is still going on, independently
/// of whether its screen happens to be on top.
///
/// THE PROBLEM THIS EXISTS FOR
///   The assistant is a destination inside the account sheet. Asking it to take
///   you somewhere therefore did three things in a row: moved the app, closed
///   the assistant, and revealed the SETTINGS SCREEN it had been sitting on top
///   of. Closing that finally showed the right place, with the assistant gone
///   and the conversation with it. Being taken somewhere by a voice you are in
///   the middle of talking to should not end the conversation, any more than a
///   colleague pointing at a screen ends theirs.
///
///   So the fact "a conversation is live" is lifted out of the view that draws
///   it. The screen can come and go; this does not.
///
/// WHY A SINGLETON, WHICH IS USUALLY THE WRONG ANSWER
///   The floating orb is drawn at the app root and the conversation is owned
///   several screens down inside a sheet. There is no shared ancestor that is
///   not the root itself, and threading a binding from the root through the tab
///   view, the account sheet and its navigation stack would put assistant
///   plumbing into four screens that are not the assistant.
@MainActor
final class AssistantPresence: ObservableObject {
    static let shared = AssistantPresence()

    /// A conversation the operator has not finished. Set when they are moved
    /// somewhere mid-conversation, cleared when they end it or the assistant
    /// becomes unavailable.
    @Published private(set) var isLive = false

    /// Where they were taken, purely so the orb can say it once. A person who
    /// looks up mid-sentence and finds a different screen deserves to know
    /// which screen, without having to work it out from what is on it.
    @Published private(set) var lastDestination: String?

    /// The conversation's phase, mirrored here so the floating orb can show it.
    ///
    /// The model that owns this is inside a sheet several screens down, and it
    /// carries the transcript and the purge-on-background behaviour that must
    /// stay tied to its screen. Mirroring one enum is far less invasive than
    /// hoisting all of that to the root, and a plain static would not redraw
    /// anything: the root observes this object, and only published changes on
    /// it reach the orb.
    @Published private(set) var phase: AssistantPhase = .idle

    func note(phase: AssistantPhase) {
        guard phase != self.phase else { return }
        self.phase = phase
    }

    private init() {}

    /// The conversation continues somewhere else in the app.
    func continueElsewhere(destination: String?) {
        isLive = true
        lastDestination = destination
    }

    /// The screen is back in front of them, so the floating orb is redundant.
    func returnedToConversation() {
        isLive = false
        lastDestination = nil
    }

    /// Ended, signed out, or no longer permitted. Anything that means there is
    /// nothing to go back to.
    func end() {
        isLive = false
        lastDestination = nil
    }
}
