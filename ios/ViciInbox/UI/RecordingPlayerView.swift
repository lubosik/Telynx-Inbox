import SwiftUI
import AVFoundation

/// Plays a call recording inline in call history.
///
/// The audio is downloaded to a temporary file first, then played with
/// AVAudioPlayer, rather than streamed. The endpoint is cookie-authenticated
/// and replies with a 302 to a short-lived signed URL, which APIClient's
/// URLSession handles and AVPlayer does not. Playing a local file also makes
/// scrubbing instant rather than re-buffering on every drag.
@MainActor
final class RecordingPlayer: NSObject, ObservableObject {
    @Published private(set) var isLoading = false
    @Published private(set) var isPlaying = false
    @Published private(set) var duration: TimeInterval = 0
    @Published var currentTime: TimeInterval = 0
    @Published private(set) var errorMessage: String?

    /// True while the user drags the scrubber, so the ticking clock does not
    /// fight the thumb for control of the position.
    @Published var isScrubbing = false

    private var player: AVAudioPlayer?
    private var ticker: Timer?
    private let callLogID: String

    init(callLogID: String) {
        self.callLogID = callLogID
        super.init()
    }

    deinit { ticker?.invalidate() }

    var isReady: Bool { player != nil }

    /// Load on first press of play, not when the row appears — call history can
    /// show dozens of recordings and downloading them all would be wasteful.
    func togglePlayback() async {
        if player == nil {
            await load()
            guard player != nil else { return }
        }
        isPlaying ? pause() : play()
    }

    private func load() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            let fileURL = try await APIClient.shared.downloadRecording(callLogID: callLogID)

            // Play through the speaker rather than the earpiece, and do not stop
            // whatever else the phone is playing until the user actually starts.
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try? AVAudioSession.sharedInstance().setActive(true)

            let audio = try AVAudioPlayer(contentsOf: fileURL)
            audio.delegate = self
            audio.prepareToPlay()
            player = audio
            duration = audio.duration
        } catch {
            errorMessage = (error as? APIError)?.errorDescription ?? "Could not load this recording."
        }
    }

    func play() {
        guard let player else { return }
        player.play()
        isPlaying = true
        ticker?.invalidate()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let player = self.player, !self.isScrubbing else { return }
                self.currentTime = player.currentTime
            }
        }
    }

    func pause() {
        player?.pause()
        isPlaying = false
        ticker?.invalidate()
        ticker = nil
    }

    /// Skip by a signed number of seconds, clamped to the recording.
    func skip(_ seconds: TimeInterval) {
        guard let player else { return }
        seek(to: min(max(player.currentTime + seconds, 0), player.duration))
    }

    func seek(to time: TimeInterval) {
        guard let player else { return }
        player.currentTime = time
        currentTime = time
    }

    /// Release the audio session when the row collapses, so a paused recording
    /// does not keep the session claimed and interfere with a call.
    func stop() {
        pause()
        player?.stop()
        player = nil
        currentTime = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    static func timestamp(_ seconds: TimeInterval) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let whole = Int(seconds)
        return "\(whole / 60):\(String(format: "%02d", whole % 60))"
    }
}

extension RecordingPlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
            self.ticker?.invalidate()
            self.ticker = nil
            // Rewind so pressing play again restarts rather than doing nothing.
            self.currentTime = 0
            self.player?.currentTime = 0
        }
    }
}

/// The inline transport: play/pause, skip back and forward, and a scrubber.
struct RecordingPlayerView: View {
    @StateObject private var player: RecordingPlayer

    init(callLogID: String) {
        _player = StateObject(wrappedValue: RecordingPlayer(callLogID: callLogID))
    }

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 22) {
                Button { player.skip(-15) } label: {
                    Image(systemName: "gobackward.15").font(.title3)
                }
                .buttonStyle(.borderless)
                .disabled(!player.isReady)

                Button {
                    Task { await player.togglePlayback() }
                } label: {
                    if player.isLoading {
                        ProgressView().controlSize(.small).frame(width: 34, height: 34)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                            .font(.system(size: 34))
                            .foregroundColor(ViciTheme.tealFill)
                    }
                }
                .buttonStyle(.borderless)
                .disabled(player.isLoading)

                Button { player.skip(15) } label: {
                    Image(systemName: "goforward.15").font(.title3)
                }
                .buttonStyle(.borderless)
                .disabled(!player.isReady)

                Spacer()

                Text("\(RecordingPlayer.timestamp(player.currentTime)) / \(RecordingPlayer.timestamp(player.duration))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Slider(
                value: $player.currentTime,
                in: 0...max(player.duration, 0.01),
                onEditingChanged: { editing in
                    player.isScrubbing = editing
                    if !editing { player.seek(to: player.currentTime) }
                }
            )
            .disabled(!player.isReady)
            .tint(ViciTheme.tealFill)

            if let message = player.errorMessage {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(.vertical, 6)
        .onDisappear { player.stop() }
    }
}
