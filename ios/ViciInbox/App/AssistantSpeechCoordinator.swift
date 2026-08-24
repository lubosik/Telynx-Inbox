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
    }

    var canBeginPushToTalk: Bool {
        guard !callIsActive else { return false }
        switch phase {
        case .readyToRequest, .ready, .microphoneDenied, .failed: return true
        default: return false
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

    private func takePendingDictation() -> AssistantFinalizedDictation? {
        pendingDictation.consume()
    }

    /// Speaks only the fixed local shell response. The selected voice exists on
    /// this device, and its listening quality is deliberately not claimed.
    @discardableResult
    func speak(_ text: String, completion: @escaping () -> Void) -> Bool {
        guard !callIsActive else { return false }
        let started = voiceOutput.speak(text, completion: completion)
        voiceDisclosure = started
            ? "An installed locale-matching Apple voice is selected. Listening quality still needs physical-iPhone review."
            : "No installed locale-matching Apple voice is available. Typed input still works."
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
private final class AssistantVoiceOutput: NSObject, AVSpeechSynthesizerDelegate {
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

    func stop() {
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
