import Foundation
import Combine
import AVFoundation
import AVFAudio
import Speech

@MainActor
private protocol AssistantSpeechCapturing: AnyObject {
    func stopAudioImmediately()
    func finishAnalysis(cancelled: Bool) async -> AssistantSpeechCaptureResult
}

private struct AssistantSpeechCaptureResult {
    let text: String
    let firstTranscriptSample: (startUptime: TimeInterval, endUptime: TimeInterval)?

    static let empty = AssistantSpeechCaptureResult(text: "", firstTranscriptSample: nil)
}

/// Owns only the Assistant's short-lived speech capture and local voice output.
/// It never reaches into the telephony stack, a backend, or disk.
@MainActor
final class AssistantSpeechCoordinator: NSObject, ObservableObject {
    @Published private(set) var phase: AssistantSpeechPhase
    @Published private(set) var liveTranscript = ""
    @Published private(set) var dictationSequence = 0
    @Published private(set) var voiceDisclosure: String?

    private var machine: AssistantSpeechStateMachine
    private var preparationTask: Task<Void, Never>?
    private var captureTimeoutTask: Task<Void, Never>?
    private var capture: AssistantSpeechCapturing?
    private var pendingDictation = AssistantFinalizedDictationSlot()
    private var pressIsHeld = false
    private var callIsActive = false
    private var generation = 0
    private let latencyRecorder: AssistantLatencyRecorder
    private let voiceOutput: AssistantVoiceOutput

    override init() {
        let supported: Bool
        if #available(iOS 26.0, *) { supported = true }
        else { supported = false }
        let initialMachine = AssistantSpeechStateMachine(supportsSpeechAnalyzer: supported)
        machine = initialMachine
        phase = initialMachine.phase
        let recorder = AssistantLatencyRecorder.shared
        latencyRecorder = recorder
        voiceOutput = AssistantVoiceOutput(latencyRecorder: recorder)
        super.init()
        // AFTER super.init, because the closure captures self and Swift will
        // not allow that before the superclass is initialised.
        //
        // Playback must never wrestle the audio session away from CallKit. Note
        // this coordinator's callIsActive is a stored Bool; the capture
        // pipeline lower in this file has a closure of the same name.
        voiceOutput.callIsActive = { [weak self] in self?.callIsActive ?? false }
    }

    /// `.listening` and `.finalizing` are excluded because a capture is already
    /// running. Every other non-call state may start one, including while the
    /// assistant is still speaking: the view stops the answer before it calls
    /// this, so barge-in is a stop followed by a normal start rather than two
    /// audio paths competing.
    var canBeginPushToTalk: Bool {
        guard !callIsActive else { return false }
        switch phase {
        case .listening, .finalizing, .interruptedByCall: return false
        case .unavailable: return false
        default: return true
        }
    }

    /// Called on touch-down, never on page appearance. This is the only route
    /// to the microphone permission prompt or an Apple asset download.
    func beginPushToTalk(callIsActive: Bool) {
        guard !callIsActive, canBeginPushToTalk else { return }
        self.callIsActive = false
        pressIsHeld = true
        generation += 1
        let requestedGeneration = generation
        guard machine.pressBegan() else { return }
        publishPhase()

        preparationTask?.cancel()
        preparationTask = Task { [weak self] in
            await self?.prepareAndStart(generation: requestedGeneration)
        }
    }

    /// Called on touch-up. Preparation and system asset installation may finish
    /// safely, but capture never starts after the finger has been released.
    func endPushToTalk() {
        cancelSilenceTimer()
        pressIsHeld = false
        captureTimeoutTask?.cancel()
        captureTimeoutTask = nil
        guard let activeCapture = capture else { return }
        capture = nil
        activeCapture.stopAudioImmediately()
        guard machine.pressEnded() else {
            Task { _ = await activeCapture.finishAnalysis(cancelled: true) }
            return
        }
        publishPhase()

        let finishingGeneration = generation
        Task { [weak self] in
            let result = await activeCapture.finishAnalysis(cancelled: false)
            guard let self,
                  finishingGeneration == self.generation,
                  !self.callIsActive else { return }
            if let sample = result.firstTranscriptSample {
                self.latencyRecorder.record(
                    .speechFirstTranscriptCallback,
                    startUptime: sample.startUptime,
                    endUptime: sample.endUptime
                )
            }
            self.liveTranscript = ""
            let cleaned = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !cleaned.isEmpty {
                self.pendingDictation.publish(AssistantFinalizedDictation(
                    text: String(cleaned.prefix(AssistantInputPolicy.maximumCharacters)),
                    completionUptime: AssistantMonotonicClock.now
                ))
                self.dictationSequence += 1
            }
            _ = self.machine.finishTranscription()
            self.publishPhase()
        }
    }

    func consumeDictation() -> String? {
        takePendingDictation()?.text
    }

    /// The richer exactly-once form lets the navigation layer measure from
    /// speech completion without placing the dictated text in telemetry.
    func consumeFinalizedDictation() -> AssistantFinalizedDictation? {
        takePendingDictation()
    }

    // MARK: - Covering the wait

    /// Says a short "let me check" ONLY if the answer is still not back.
    ///
    /// WHY IT IS DELAYED RATHER THAN IMMEDIATE
    ///   A tool-backed answer takes four to five seconds, because the model
    ///   makes one round trip to choose the tool and another to phrase the
    ///   result. That silence is what reads as broken. But a refusal or a
    ///   follow-up answered from memory comes back in about two, and putting
    ///   "one moment" in front of those makes a fast answer feel slower and the
    ///   assistant feel scripted.
    ///
    ///   So the filler is armed, not spoken. If the answer arrives first the
    ///   timer is cancelled and nothing is said. Only real dead air gets
    ///   covered.
    ///
    /// It is never spoken over. `cancelThinkingFiller` stops it before the real
    /// answer begins, and the completion is deliberately empty so finishing the
    /// filler does not release the turn.
    private static let fillerDelay: Duration = .milliseconds(900)

    private var fillerTask: Task<Void, Never>?

    func armThinkingFiller() {
        cancelThinkingFiller()
        // Varied so a demo of several questions in a row does not sound like a
        // recording. Deliberately all short: this must finish well before a
        // four second answer arrives.
        let lines = ["One moment.", "Let me check.", "One second.", "Give me a moment."]
        let line = lines.randomElement() ?? "One moment."
        fillerTask = Task { [weak self] in
            try? await Task.sleep(for: Self.fillerDelay)
            guard !Task.isCancelled, let self, !self.callIsActive else { return }
            _ = self.voiceOutput.speakWithServerVoice(
                line,
                voiceID: AssistantPreferences.shared.pinnedVoiceIdentifier,
                completion: {}
            )
        }
    }

    func cancelThinkingFiller() {
        fillerTask?.cancel()
        fillerTask = nil
    }

    private func takePendingDictation() -> AssistantFinalizedDictation? {
        pendingDictation.consume()
    }

    /// Speaks only the fixed local shell response. The selected voice exists on
    /// this device, and its listening quality is deliberately not claimed.
    @discardableResult
    func speak(_ text: String, completion: @escaping () -> Void) -> Bool {
        guard !callIsActive else { return false }
        // Server voice first. It falls back to Apple's synthesiser internally
        // when the network or the provider cannot deliver, so this call always
        // results in the answer being spoken by something.
        let started = voiceOutput.speakWithServerVoice(
            text,
            voiceID: AssistantPreferences.shared.pinnedVoiceIdentifier,
            completion: completion
        )
        voiceDisclosure = started
            ? "Answers are spoken with the voice chosen in Settings, synthesised in the cloud."
            : "No voice is available right now. Typed input still works."
        return started
    }

    /// The app's call state is observed, never controlled. A non-idle call
    /// synchronously stops microphone capture and speech output before any
    /// asynchronous analyzer cleanup begins.
    func noteCallActivity(_ active: Bool) {
        callIsActive = active
        if active {
            stopAll(interruptedByCall: true)
        } else if machine.callEnded() {
            publishPhase()
        }
    }

    func stopAll(interruptedByCall: Bool = false) {
        stopAll(interruptedByCall: interruptedByCall, stopVoiceOutput: true)
    }

    /// Used only while the Assistant sheet is handing navigation to a verified
    /// destination. Capture and private dictation are destroyed, while a
    /// destination-owned fixed confirmation may start immediately afterward.
    func stopCaptureKeepingVoiceOutput() {
        stopAll(interruptedByCall: false, stopVoiceOutput: false)
    }

    private func stopAll(interruptedByCall: Bool, stopVoiceOutput: Bool) {
        generation += 1
        pressIsHeld = false
        preparationTask?.cancel()
        preparationTask = nil
        captureTimeoutTask?.cancel()
        captureTimeoutTask = nil
        liveTranscript = ""
        pendingDictation.clear()

        let activeCapture = capture
        capture = nil
        activeCapture?.stopAudioImmediately()
        if let activeCapture {
            Task { _ = await activeCapture.finishAnalysis(cancelled: true) }
        }
        if stopVoiceOutput { voiceOutput.stop() }

        if interruptedByCall {
            machine.interruptForCall()
        } else {
            let supportsAnalyzer: Bool
            if #available(iOS 26.0, *) { supportsAnalyzer = true }
            else { supportsAnalyzer = false }
            machine = AssistantSpeechStateMachine(supportsSpeechAnalyzer: supportsAnalyzer)
        }
        publishPhase()
    }

    private func publishPhase() {
        phase = machine.phase
    }

    private func recognitionFailed(generation expectedGeneration: Int) {
        guard expectedGeneration == generation, !callIsActive else { return }
        let failedCapture = capture
        capture = nil
        failedCapture?.stopAudioImmediately()
        if let failedCapture {
            Task { _ = await failedCapture.finishAnalysis(cancelled: true) }
        }
        liveTranscript = ""
        machine.fail()
        publishPhase()
    }

    private func updateTranscript(_ text: String, generation expectedGeneration: Int) {
        guard expectedGeneration == generation, !callIsActive else { return }
        liveTranscript = String(text.prefix(AssistantInputPolicy.maximumCharacters))
        armSilenceTimer()
    }

    // MARK: - Stopping when the person stops

    /// How long the transcript must stand still before capture ends itself.
    ///
    /// Short enough that finishing a sentence and waiting does not feel like the
    /// phone has forgotten you. Long enough to survive the natural pause in the
    /// middle of "how are we doing... this week". Ordinary speech pauses run to
    /// about a second; this sits beyond that without dragging.
    private static let silenceBeforeStopping: Duration = .milliseconds(1_500)

    private var silenceTimer: Task<Void, Never>?

    /// Restarted on every transcript update, so the countdown measures silence
    /// rather than elapsed time. It only ends capture once something has
    /// actually been said: an empty transcript means the microphone opened and
    /// nobody spoke, and cutting that off after a second and a half would make
    /// the assistant impossible to use in a quiet room.
    private func armSilenceTimer() {
        silenceTimer?.cancel()
        guard machine.phase == .listening,
              !liveTranscript.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        silenceTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.silenceBeforeStopping)
            guard !Task.isCancelled, let self, self.machine.phase == .listening else { return }
            self.endPushToTalk()
        }
    }

    private func cancelSilenceTimer() {
        silenceTimer?.cancel()
        silenceTimer = nil
    }

    private func prepareAndStart(generation expectedGeneration: Int) async {
        guard #available(iOS 26.0, *) else {
            machine.makeUnavailable(.requiresIOS26)
            publishPhase()
            return
        }

        let microphoneGranted = await AVAudioApplication.requestRecordPermission()
        guard expectedGeneration == generation, !callIsActive else { return }
        _ = machine.resolveMicrophonePermission(granted: microphoneGranted)
        publishPhase()
        guard microphoneGranted else { return }

        guard SpeechTranscriber.isAvailable else {
            machine.makeUnavailable(.hardwareUnsupported)
            publishPhase()
            return
        }
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else {
            machine.makeUnavailable(.localeUnsupported)
            publishPhase()
            return
        }

        let assetTranscriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let initialStatus = await AssetInventory.status(forModules: [assetTranscriber])
        guard expectedGeneration == generation, !callIsActive else { return }

        switch initialStatus {
        case .unsupported:
            machine.makeUnavailable(.localeUnsupported)
            publishPhase()
            return
        case .installed:
            break
        case .supported, .downloading:
            _ = machine.beginAssetDownload()
            publishPhase()
            do {
                if let request = try await AssetInventory.assetInstallationRequest(
                    supporting: [assetTranscriber]
                ) {
                    try await request.downloadAndInstall()
                }
            } catch is CancellationError {
                return
            } catch {
                guard expectedGeneration == generation, !callIsActive else { return }
                machine.fail()
                publishPhase()
                return
            }
            guard await AssetInventory.status(forModules: [assetTranscriber]) == .installed else {
                guard expectedGeneration == generation, !callIsActive else { return }
                machine.fail()
                publishPhase()
                return
            }
        @unknown default:
            machine.fail()
            publishPhase()
            return
        }

        guard expectedGeneration == generation, !callIsActive else { return }
        guard pressIsHeld else {
            _ = machine.assetsReady(pressIsHeld: false)
            publishPhase()
            return
        }

        do {
            let newCapture = try await IOS26AssistantSpeechCapture.start(
                locale: locale,
                latencyRecorder: latencyRecorder,
                shouldContinue: { [weak self] in
                    guard let self else { return false }
                    return expectedGeneration == self.generation
                        && self.pressIsHeld
                        && !self.callIsActive
                },
                callIsActive: { [weak self] in self?.callIsActive ?? true },
                onText: { [weak self] text in
                    self?.updateTranscript(text, generation: expectedGeneration)
                },
                onFailure: { [weak self] in
                    self?.recognitionFailed(generation: expectedGeneration)
                }
            )
            guard expectedGeneration == generation, !callIsActive, pressIsHeld else {
                newCapture.stopAudioImmediately()
                _ = await newCapture.finishAnalysis(cancelled: true)
                _ = machine.assetsReady(pressIsHeld: false)
                publishPhase()
                return
            }
            capture = newCapture
            _ = machine.assetsReady(pressIsHeld: true)
            publishPhase()
            captureTimeoutTask?.cancel()
            captureTimeoutTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 30_000_000_000)
                guard !Task.isCancelled else { return }
                self?.endPushToTalk()
            }
        } catch is CancellationError {
            return
        } catch {
            guard expectedGeneration == generation, !callIsActive else { return }
            machine.fail()
            publishPhase()
        }
    }
}

@available(iOS 26.0, *)
@MainActor
private final class IOS26AssistantSpeechCapture: AssistantSpeechCapturing {
    private let analyzer: SpeechAnalyzer
    private let transcriber: SpeechTranscriber
    private let audioEngine = AVAudioEngine()
    private let inputContinuation: AsyncStream<AnalyzerInput>.Continuation
    private var resultTask: Task<Void, Never>?
    private var resultStreamFailed = false
    private var tapIsInstalled = false
    private var audioSessionIsOwned = false
    private var audioObservers: [NSObjectProtocol] = []
    private var finalizedText = ""
    private var volatileText = ""
    private let onText: (String) -> Void
    private let onFailure: () -> Void
    private let shouldContinue: () -> Bool
    private let callIsActive: () -> Bool
    private let latencyRecorder: AssistantLatencyRecorder
    private var firstTranscriptLatency = AssistantFirstTranscriptLatencyTracker()
    private var pendingFirstTranscriptSample: (startUptime: TimeInterval, endUptime: TimeInterval)?

    private init(analyzer: SpeechAnalyzer,
                 transcriber: SpeechTranscriber,
                 inputContinuation: AsyncStream<AnalyzerInput>.Continuation,
                 latencyRecorder: AssistantLatencyRecorder,
                 shouldContinue: @escaping () -> Bool,
                 callIsActive: @escaping () -> Bool,
                 onText: @escaping (String) -> Void,
                 onFailure: @escaping () -> Void) {
        self.analyzer = analyzer
        self.transcriber = transcriber
        self.inputContinuation = inputContinuation
        self.latencyRecorder = latencyRecorder
        self.shouldContinue = shouldContinue
        self.callIsActive = callIsActive
        self.onText = onText
        self.onFailure = onFailure
    }

    static func start(locale: Locale,
                      latencyRecorder: AssistantLatencyRecorder,
                      shouldContinue: @escaping () -> Bool,
                      callIsActive: @escaping () -> Bool,
                      onText: @escaping (String) -> Void,
                      onFailure: @escaping () -> Void) async throws -> IOS26AssistantSpeechCapture {
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (inputSequence, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        let capture = IOS26AssistantSpeechCapture(
            analyzer: analyzer,
            transcriber: transcriber,
            inputContinuation: inputBuilder,
            latencyRecorder: latencyRecorder,
            shouldContinue: shouldContinue,
            callIsActive: callIsActive,
            onText: onText,
            onFailure: onFailure
        )
        try await capture.start(inputSequence: inputSequence)
        return capture
    }

    private func start(inputSequence: AsyncStream<AnalyzerInput>) async throws {
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber]
        ) else {
            throw AssistantSpeechCaptureError.noCompatibleAudioFormat
        }

        guard shouldContinue() else { throw CancellationError() }

        // Own a recording session only for the held gesture. Empty options are
        // intentional: `.duckOthers` is not valid with the `.record` category.
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: [])
            try audioSession.setActive(true)
            audioSessionIsOwned = true
            guard shouldContinue() else { throw CancellationError() }

            // Activation can change the hardware input format. Read it only
            // after activation, then build the converter and analyzer pipeline.
            let inputNode = audioEngine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            guard let converter = AssistantPCMBufferConverter(
                inputFormat: inputFormat,
                outputFormat: analyzerFormat
            ) else {
                throw AssistantSpeechCaptureError.noCompatibleAudioFormat
            }

            try await analyzer.prepareToAnalyze(in: analyzerFormat)
            guard shouldContinue() else { throw CancellationError() }

            resultTask = Task { [weak self, transcriber] in
                do {
                    for try await result in transcriber.results {
                        guard let self else { return }
                        let text = String(result.text.characters)
                        let hasText = !text.trimmingCharacters(
                            in: .whitespacesAndNewlines
                        ).isEmpty
                        if !self.callIsActive(),
                           let sample = self.firstTranscriptLatency.consumeFirstNonemptyCallback(
                               containsNonWhitespaceText: hasText,
                               resultAudioStartSeconds: result.range.start.seconds,
                               callbackUptime: AssistantMonotonicClock.now
                           ) {
                            self.pendingFirstTranscriptSample = sample
                        }
                        if result.isFinal {
                            self.finalizedText = Self.join(self.finalizedText, text)
                            self.volatileText = ""
                        } else {
                            self.volatileText = text
                        }
                        self.onText(Self.join(self.finalizedText, self.volatileText))
                    }
                } catch is CancellationError {
                    self?.resultStreamFailed = true
                    return
                } catch {
                    self?.resultStreamFailed = true
                    self?.onFailure()
                }
            }

            try await analyzer.start(inputSequence: inputSequence)
            guard shouldContinue() else { throw CancellationError() }

            inputNode.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) {
                [weak self] buffer, _ in
                guard let self else { return }
                do {
                    let converted = try converter.convert(buffer)
                    self.inputContinuation.yield(AnalyzerInput(buffer: converted))
                } catch {
                    self.inputContinuation.finish()
                    Task { @MainActor [weak self] in self?.onFailure() }
                }
            }
            tapIsInstalled = true

            installAudioFailureObservers()

            audioEngine.prepare()
            let audioTimelineStartUptime = AssistantMonotonicClock.now
            try audioEngine.start()
            firstTranscriptLatency.noteAudioTimelineStarted(at: audioTimelineStartUptime)
            guard shouldContinue() else { throw CancellationError() }
        } catch {
            await cancelFailedSetup(deactivateSession: !callIsActive())
            throw error
        }
    }

    func stopAudioImmediately() {
        if tapIsInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapIsInstalled = false
        }
        audioEngine.stop()
        inputContinuation.finish()
        if audioSessionIsOwned {
            // Do not deactivate the process-wide session after CallKit has
            // begun taking ownership. The call path will configure it.
            if !callIsActive() {
                try? AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
            }
            audioSessionIsOwned = false
        }
        removeAudioFailureObservers()
    }

    func finishAnalysis(cancelled: Bool) async -> AssistantSpeechCaptureResult {
        if cancelled {
            firstTranscriptLatency.cancel()
            pendingFirstTranscriptSample = nil
        }
        stopAudioImmediately()
        if cancelled {
            resultTask?.cancel()
            await analyzer.cancelAndFinishNow()
            finalizedText = ""
            volatileText = ""
            return .empty
        }

        let analysisSucceeded: Bool
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            await resultTask?.value
            analysisSucceeded = true
        } catch {
            resultTask?.cancel()
            analysisSucceeded = false
        }
        guard analysisSucceeded, !resultStreamFailed, !callIsActive() else {
            pendingFirstTranscriptSample = nil
            if callIsActive() {
                finalizedText = ""
                volatileText = ""
                return .empty
            }
            return AssistantSpeechCaptureResult(
                text: Self.join(finalizedText, volatileText),
                firstTranscriptSample: nil
            )
        }
        let sample = pendingFirstTranscriptSample
        pendingFirstTranscriptSample = nil
        return AssistantSpeechCaptureResult(
            text: Self.join(finalizedText, volatileText),
            firstTranscriptSample: sample
        )
    }

    private func cancelFailedSetup(deactivateSession: Bool) async {
        firstTranscriptLatency.cancel()
        pendingFirstTranscriptSample = nil
        if tapIsInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapIsInstalled = false
        }
        audioEngine.stop()
        inputContinuation.finish()
        resultTask?.cancel()
        await analyzer.cancelAndFinishNow()
        if audioSessionIsOwned {
            if deactivateSession {
                try? AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
            }
            audioSessionIsOwned = false
        }
        removeAudioFailureObservers()
    }

    private func installAudioFailureObservers() {
        let center = NotificationCenter.default
        audioObservers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor [weak self] in self?.failClosedForAudioChange() }
        })
        audioObservers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw),
                  reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory else { return }
            Task { @MainActor [weak self] in self?.failClosedForAudioChange() }
        })
    }

    private func removeAudioFailureObservers() {
        let center = NotificationCenter.default
        audioObservers.forEach(center.removeObserver)
        audioObservers.removeAll(keepingCapacity: false)
    }

    private func failClosedForAudioChange() {
        firstTranscriptLatency.cancel()
        pendingFirstTranscriptSample = nil
        stopAudioImmediately()
        onFailure()
    }

    private static func join(_ first: String, _ second: String) -> String {
        let left = first.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = second.trimmingCharacters(in: .whitespacesAndNewlines)
        if left.isEmpty { return right }
        if right.isEmpty { return left }
        return left + " " + right
    }
}

private enum AssistantSpeechCaptureError: Error {
    case noCompatibleAudioFormat
    case conversionFailed
}

/// Xcode 26-compatible conversion for microphone buffers.
private final class AssistantPCMBufferConverter {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat

    init?(inputFormat: AVAudioFormat, outputFormat: AVAudioFormat) {
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            return nil
        }
        self.converter = converter
        self.outputFormat = outputFormat
    }

    func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let ratio = outputFormat.sampleRate / input.format.sampleRate
        let capacity = max(1, AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32)
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            throw AssistantSpeechCaptureError.conversionFailed
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return input
        }
        if status == .error || conversionError != nil {
            if let conversionError { throw conversionError }
            throw AssistantSpeechCaptureError.conversionFailed
        }
        return output
    }
}

@MainActor
private final class AssistantVoiceOutput: NSObject, AVSpeechSynthesizerDelegate, AVAudioPlayerDelegate {
    private static let selectedIdentifierKey = "assistant_selected_voice_identifier"
    private let synthesizer = AVSpeechSynthesizer()
    private let defaults: UserDefaults
    private let latencyRecorder: AssistantLatencyRecorder
    private var completion: (() -> Void)?
    private var completionTimeoutTask: Task<Void, Never>?
    private var activeUtterance: AVSpeechUtterance?
    private var queuedUptime: TimeInterval?
    private var didRecordStart = false

    init(defaults: UserDefaults = .standard,
         latencyRecorder: AssistantLatencyRecorder = .shared) {
        self.defaults = defaults
        self.latencyRecorder = latencyRecorder
        super.init()
        synthesizer.usesApplicationAudioSession = false
        if #available(iOS 17.0, *) {
            synthesizer.mixToTelephonyUplink = false
        }
        synthesizer.delegate = self
    }

    /// Plays the ElevenLabs audio the server produced, falling back to Apple's
    /// synthesiser when it cannot.
    ///
    /// FALLBACK IS NOT OPTIONAL HERE
    ///   The voice now depends on a network round trip. A dead connection, an
    ///   expired credential or a provider outage would otherwise turn a talking
    ///   assistant into a silent one, and silence on a voice interface reads as
    ///   a crash. Apple's voice is worse and it is always there, so an answer
    ///   still gets spoken and the person still learns what the system said.
    private var audioPlayer: AVAudioPlayer?
    /// Set by the coordinator. Playback must not touch the session while
    /// CallKit owns it.
    var callIsActive: () -> Bool = { false }

    /// PUTS THE SESSION BACK INTO A STATE WHERE SOUND COMES OUT.
    ///
    /// Capture sets the category to `.record` with mode `.measurement` and then
    /// deactivates, which leaves the CATEGORY on `.record`. An AVAudioPlayer on
    /// a `.record` session plays silently: no error, no warning, no audio. That
    /// is exactly what happened, and it was invisible because the previous
    /// voice was AVSpeechSynthesizer with `usesApplicationAudioSession = false`,
    /// which manages its own session and is therefore immune to this.
    ///
    /// `.spokenAudio` is the mode for speech playback, and `.duckOthers` lowers
    /// music rather than stopping it, which is the polite behaviour for an
    /// assistant that talks for three seconds.
    private func prepareSessionForPlayback() -> Bool {
        guard !callIsActive() else { return false }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            return true
        } catch {
            return false
        }
    }

    /// Hands the session back so other audio can resume. Never while a call is
    /// up: the call path owns the session then and will configure it itself.
    private func releaseSessionAfterPlayback() {
        guard !callIsActive() else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    @discardableResult
    func speakWithServerVoice(_ text: String,
                              voiceID: String?,
                              completion: @escaping () -> Void) -> Bool {
        stop()
        self.completion = completion
        queuedUptime = AssistantMonotonicClock.now
        didRecordStart = false

        Task { [weak self] in
            do {
                let data = try await APIClient.shared.assistantSpeak(text: text, voiceID: voiceID)
                guard let self else { return }
                try await MainActor.run {
                    // Without this the player runs happily and produces silence.
                    guard self.prepareSessionForPlayback() else {
                        _ = self.speakLocally(text)
                        return
                    }
                    let player = try AVAudioPlayer(data: data)
                    player.delegate = self
                    self.audioPlayer = player
                    player.volume = 1.0
                    player.prepareToPlay()
                    // play() RETURNING FALSE IS THE STUCK STATE.
                    //
                    // When it refuses, no delegate callback ever fires, so the
                    // completion that releases the turn is never called and the
                    // shell sits on "Speaking" forever. That is exactly what
                    // shipped: silent audio and a phase that never ended.
                    // Treated as a failure to speak, not as speech.
                    guard player.play() else {
                        self.audioPlayer = nil
                        self.releaseSessionAfterPlayback()
                        _ = self.speakLocally(text)
                        return
                    }
                    self.noteStartedIfNeeded()
                    self.armPlaybackWatchdog(duration: player.duration)
                }
            } catch {
                // Fall back rather than fail. Recorded as a fallback so a
                // persistently broken voice shows up as a pattern instead of as
                // "the assistant seems quiet sometimes".
                guard let self else { return }
                await MainActor.run { _ = self.speakLocally(text) }
            }
        }
        return true
    }

    /// Releases the turn if the delegate never reports finishing.
    ///
    /// Every path into speech has to end in the completion being called, or the
    /// assistant cannot be spoken to again. The synthesiser path already had a
    /// timeout for this. The server path did not, and a single silent failure
    /// left the shell wedged with no way back except restarting the app.
    ///
    /// Sized from the clip itself plus a margin, so it never truncates real
    /// audio and never waits a fixed long time for a short answer.
    private var playbackWatchdog: Task<Void, Never>?

    private func armPlaybackWatchdog(duration: TimeInterval) {
        playbackWatchdog?.cancel()
        let allowance = max(duration, 1) + 5
        playbackWatchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(allowance))
            guard !Task.isCancelled, let self, self.audioPlayer != nil else { return }
            self.audioPlayer = nil
            self.releaseSessionAfterPlayback()
            self.finishOnce()
        }
    }

    private func cancelPlaybackWatchdog() {
        playbackWatchdog?.cancel()
        playbackWatchdog = nil
    }

    private func noteStartedIfNeeded() {
        guard !didRecordStart else { return }
        didRecordStart = true
        guard let queuedUptime else { return }
        // Same metric the synthesiser path records, so the two voices are
        // measured on one scale and a regression is visible whichever is in use.
        latencyRecorder.record(
            .voiceOutputStartProxy,
            startUptime: queuedUptime,
            endUptime: AssistantMonotonicClock.now
        )
    }

    @discardableResult
    private func speakLocally(_ text: String) -> Bool {
        speak(text, completion: completion ?? {})
    }

    @discardableResult
    func speak(_ text: String, completion: @escaping () -> Void) -> Bool {
        stop()
        let localeIdentifier = AVSpeechSynthesisVoice.currentLanguageCode()
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let candidates = voices.map {
            AssistantVoiceCandidate(
                identifier: $0.identifier,
                language: $0.language,
                quality: Self.quality($0.quality)
            )
        }
        // A voice the operator pinned in Settings wins outright while it is
        // still installed. `select` treats a stored identifier as a tie-break
        // at the best quality, which is correct for a remembered automatic
        // pick and wrong for a deliberate choice: it would let a newly
        // installed Premium voice silently override the one they picked.
        // `resolve` falls back to `select` for the automatic case and for a
        // pinned voice that has since been deleted from the device.
        let preferences = AssistantPreferences.shared
        guard let selected = AssistantVoiceSelector.resolve(
            preference: preferences.voicePreference,
            candidates: candidates,
            localeIdentifier: localeIdentifier,
            storedIdentifier: defaults.string(forKey: Self.selectedIdentifierKey)
        ), let voice = AVSpeechSynthesisVoice(identifier: selected.identifier) else {
            return false
        }

        defaults.set(selected.identifier, forKey: Self.selectedIdentifierKey)
        self.completion = completion
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        // Clamped to the range AVSpeechUtterance accepts. A rate outside it is
        // ignored silently, which would make the setting look broken.
        utterance.rate = min(
            AVSpeechUtteranceMaximumSpeechRate,
            max(AVSpeechUtteranceMinimumSpeechRate,
                AVSpeechUtteranceDefaultSpeechRate * preferences.speakingRate.multiplier)
        )
        activeUtterance = utterance
        queuedUptime = AssistantMonotonicClock.now
        didRecordStart = false
        synthesizer.speak(utterance)
        completionTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 45_000_000_000)
            guard !Task.isCancelled else { return }
            self?.stop()
        }
        return true
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.cancelPlaybackWatchdog()
            self.audioPlayer = nil
            self.releaseSessionAfterPlayback()
            self.finishOnce()
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.audioPlayer = nil
            self.finishOnce()
        }
    }

    func stop() {
        cancelPlaybackWatchdog()
        if let audioPlayer {
            audioPlayer.stop()
            self.audioPlayer = nil
            releaseSessionAfterPlayback()
        }
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        // A newly queued utterance may not report `isSpeaking` yet. Always
        // release its owner so AssistantModel cannot remain wedged in speaking.
        finishOnce()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didStart utterance: AVSpeechUtterance) {
        guard activeUtterance === utterance,
              !didRecordStart,
              let queuedUptime else { return }
        didRecordStart = true
        let delegateUptime = AssistantMonotonicClock.now
        latencyRecorder.record(
            .voiceOutputStartProxy,
            startUptime: queuedUptime,
            endUptime: delegateUptime
        )
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didFinish utterance: AVSpeechUtterance) {
        finishOnce(for: utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer,
                           didCancel utterance: AVSpeechUtterance) {
        finishOnce(for: utterance)
    }

    private func finishOnce(for utterance: AVSpeechUtterance? = nil) {
        if let utterance, activeUtterance !== utterance { return }
        completionTimeoutTask?.cancel()
        completionTimeoutTask = nil
        let action = completion
        completion = nil
        activeUtterance = nil
        queuedUptime = nil
        didRecordStart = false
        action?()
    }

    private static func quality(_ quality: AVSpeechSynthesisVoiceQuality) -> AssistantVoiceQuality {
        switch quality {
        case .premium: return .premium
        case .enhanced: return .enhanced
        default: return .standard
        }
    }
}
