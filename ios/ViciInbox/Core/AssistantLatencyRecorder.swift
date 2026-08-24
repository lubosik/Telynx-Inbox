import Foundation

/// Allowlisted, product-level timing boundaries. The recorder deliberately
/// accepts no labels, route values or arbitrary metadata, so identifiers and
/// conversation content cannot enter latency telemetry by accident.
enum AssistantLatencyMetric: String, CaseIterable, Sendable {
    case speechFirstTranscriptCallback
    case voiceOutputStartProxy
    case toolBackedAnswer
    case voiceNavigation
}

struct AssistantLatencySnapshot: Equatable, Sendable {
    let metric: AssistantLatencyMetric
    let count: Int
    let p50Milliseconds: Int?
    let p95Milliseconds: Int?
}

/// A bounded in-memory rolling distribution. Millisecond quantisation avoids
/// retaining unnecessarily precise interaction timing. No sample is persisted.
struct AssistantLatencyDistribution: Equatable, Sendable {
    static let defaultCapacity = 200
    static let maximumDurationMilliseconds = 300_000

    let capacity: Int
    private var samplesMilliseconds: [Int] = []

    init(capacity: Int = defaultCapacity) {
        self.capacity = min(max(1, capacity), Self.defaultCapacity)
    }

    @discardableResult
    mutating func record(startUptime: TimeInterval, endUptime: TimeInterval) -> Bool {
        guard startUptime.isFinite,
              endUptime.isFinite,
              startUptime >= 0,
              endUptime >= startUptime else { return false }
        let milliseconds = (endUptime - startUptime) * 1_000
        guard milliseconds.isFinite,
              milliseconds <= Double(Self.maximumDurationMilliseconds) else { return false }
        let rounded = Int(milliseconds.rounded())
        if samplesMilliseconds.count == capacity {
            samplesMilliseconds.removeFirst()
        }
        samplesMilliseconds.append(rounded)
        return true
    }

    func snapshot(metric: AssistantLatencyMetric) -> AssistantLatencySnapshot {
        let sorted = samplesMilliseconds.sorted()
        return AssistantLatencySnapshot(
            metric: metric,
            count: sorted.count,
            p50Milliseconds: percentile(50, in: sorted),
            p95Milliseconds: percentile(95, in: sorted)
        )
    }

    private func percentile(_ percent: Int, in sorted: [Int]) -> Int? {
        guard !sorted.isEmpty else { return nil }
        // Nearest-rank percentile, expressed without floating-point indexing.
        let rank = max(1, (percent * sorted.count + 99) / 100)
        return sorted[rank - 1]
    }
}

/// Process-local aggregate recorder. Its API cannot receive prompts,
/// transcripts, people, phone numbers, IDs, or identifier-bearing routes.
@MainActor
final class AssistantLatencyRecorder {
    static let shared = AssistantLatencyRecorder()

    private let capacityPerMetric: Int
    private var distributions: [AssistantLatencyMetric: AssistantLatencyDistribution] = [:]

    init(capacityPerMetric: Int = AssistantLatencyDistribution.defaultCapacity) {
        self.capacityPerMetric = min(
            max(1, capacityPerMetric),
            AssistantLatencyDistribution.defaultCapacity
        )
    }

    func record(_ metric: AssistantLatencyMetric,
                startUptime: TimeInterval,
                endUptime: TimeInterval) {
        var distribution = distributions[metric]
            ?? AssistantLatencyDistribution(capacity: capacityPerMetric)
        guard distribution.record(startUptime: startUptime, endUptime: endUptime) else { return }
        distributions[metric] = distribution
    }

    func snapshot(for metric: AssistantLatencyMetric) -> AssistantLatencySnapshot {
        (distributions[metric] ?? AssistantLatencyDistribution(capacity: capacityPerMetric))
            .snapshot(metric: metric)
    }

    func snapshots() -> [AssistantLatencySnapshot] {
        AssistantLatencyMetric.allCases.map { snapshot(for: $0) }
    }
}

enum AssistantMonotonicClock {
    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
}

/// Converts the first non-empty SpeechTranscriber callback into a monotonic
/// latency sample measured from that result's audio-range start. It records at
/// most once and becomes permanently inert after cancellation.
struct AssistantFirstTranscriptLatencyTracker: Equatable, Sendable {
    private var audioTimelineStartUptime: TimeInterval?
    private var isConsumed = false
    private var isCancelled = false

    mutating func noteAudioTimelineStarted(at uptime: TimeInterval) {
        guard !isCancelled,
              audioTimelineStartUptime == nil,
              uptime.isFinite,
              uptime >= 0 else { return }
        audioTimelineStartUptime = uptime
    }

    mutating func consumeFirstNonemptyCallback(
        containsNonWhitespaceText: Bool,
        resultAudioStartSeconds: TimeInterval,
        callbackUptime: TimeInterval
    ) -> (startUptime: TimeInterval, endUptime: TimeInterval)? {
        guard !isCancelled, !isConsumed, containsNonWhitespaceText else { return nil }
        // Even malformed timing on the first non-empty callback is consumed;
        // a later callback must never masquerade as the first one.
        isConsumed = true
        guard let audioTimelineStartUptime,
              resultAudioStartSeconds.isFinite,
              resultAudioStartSeconds >= 0,
              callbackUptime.isFinite else { return nil }
        let resultStartUptime = audioTimelineStartUptime + resultAudioStartSeconds
        guard resultStartUptime.isFinite,
              callbackUptime >= resultStartUptime else { return nil }
        return (resultStartUptime, callbackUptime)
    }

    mutating func cancel() {
        isCancelled = true
        audioTimelineStartUptime = nil
    }
}

/// The text remains inside the existing local Assistant flow. Only the
/// monotonic completion boundary is intended for later navigation timing.
struct AssistantFinalizedDictation: Equatable, Sendable {
    let text: String
    let completionUptime: TimeInterval
}

/// Small value-semantic handoff used by the coordinator. A published
/// dictation can be taken once through either compatibility or timed APIs.
struct AssistantFinalizedDictationSlot: Equatable, Sendable {
    private var pending: AssistantFinalizedDictation?

    mutating func publish(_ dictation: AssistantFinalizedDictation) {
        pending = dictation
    }

    mutating func consume() -> AssistantFinalizedDictation? {
        defer { pending = nil }
        return pending
    }

    mutating func clear() {
        pending = nil
    }
}
