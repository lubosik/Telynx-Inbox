import Foundation

@main
struct AssistantLatencyRecorderSmoke {
    @MainActor
    static func main() async {
        var distribution = AssistantLatencyDistribution(capacity: 3)
        precondition(distribution.record(startUptime: 1, endUptime: 1.030))
        precondition(distribution.record(startUptime: 2, endUptime: 2.040))
        precondition(distribution.record(startUptime: 3, endUptime: 3.050))
        precondition(distribution.record(startUptime: 4, endUptime: 4.060))
        let bounded = distribution.snapshot(metric: .voiceNavigation)
        precondition(bounded.count == 3, "the rolling sample window must stay bounded")
        precondition(bounded.p50Milliseconds == 50)
        precondition(bounded.p95Milliseconds == 60)

        precondition(!distribution.record(startUptime: 5, endUptime: 4))
        precondition(!distribution.record(startUptime: .nan, endUptime: 6))
        precondition(!distribution.record(startUptime: 0, endUptime: 301))
        precondition(distribution.snapshot(metric: .voiceNavigation) == bounded)

        var transcript = AssistantFirstTranscriptLatencyTracker()
        transcript.noteAudioTimelineStarted(at: 100)
        precondition(transcript.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: false,
            resultAudioStartSeconds: 0.25,
            callbackUptime: 100.4
        ) == nil)
        let first = transcript.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: true,
            resultAudioStartSeconds: 0.25,
            callbackUptime: 100.4
        )
        precondition(first?.startUptime == 100.25)
        precondition(first?.endUptime == 100.4)
        precondition(transcript.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: true,
            resultAudioStartSeconds: 0.30,
            callbackUptime: 100.5
        ) == nil, "duplicate result callbacks must not create samples")

        var malformedFirst = AssistantFirstTranscriptLatencyTracker()
        malformedFirst.noteAudioTimelineStarted(at: 200)
        precondition(malformedFirst.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: true,
            resultAudioStartSeconds: -1,
            callbackUptime: 201
        ) == nil)
        precondition(malformedFirst.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: true,
            resultAudioStartSeconds: 0,
            callbackUptime: 201
        ) == nil, "a later callback cannot replace a malformed first callback")

        var cancelled = AssistantFirstTranscriptLatencyTracker()
        cancelled.noteAudioTimelineStarted(at: 300)
        cancelled.cancel()
        precondition(cancelled.consumeFirstNonemptyCallback(
            containsNonWhitespaceText: true,
            resultAudioStartSeconds: 0,
            callbackUptime: 300.1
        ) == nil, "a cancelled capture must remain inert")

        var slot = AssistantFinalizedDictationSlot()
        let dictation = AssistantFinalizedDictation(text: "local only", completionUptime: 400)
        slot.publish(dictation)
        precondition(slot.consume() == dictation)
        precondition(slot.consume() == nil, "dictation consumption must be exactly once")
        slot.publish(dictation)
        slot.clear()
        precondition(slot.consume() == nil, "call/lifecycle clearing must discard dictation")

        let recorder = AssistantLatencyRecorder(capacityPerMetric: 2)
        recorder.record(.voiceOutputStartProxy, startUptime: 10, endUptime: 10.1)
        recorder.record(.voiceOutputStartProxy, startUptime: 20, endUptime: 20.2)
        recorder.record(.voiceOutputStartProxy, startUptime: 30, endUptime: 30.3)
        let voice = recorder.snapshot(for: .voiceOutputStartProxy)
        precondition(voice.count == 2)
        precondition(voice.p50Milliseconds == 200)
        precondition(voice.p95Milliseconds == 300)
        let untouched = recorder.snapshot(for: .toolBackedAnswer)
        precondition(untouched.count == 0)
        precondition(untouched.p50Milliseconds == nil)
        precondition(untouched.p95Milliseconds == nil)

        print("Assistant latency recorder smoke: OK")
    }
}
