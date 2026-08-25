import Foundation

/// Executable checks for end-of-speech detection.
///
/// This runs the real detector against synthetic level streams, so it is a
/// genuine test of the decision rather than a scan of the source. The bug it
/// exists to prevent is the one being fixed: capture that never ends itself,
/// leaving somebody tapping the orb after every sentence.
@main
struct AssistantVoiceActivitySmoke {

    /// Feed a run of levels at 46ms per buffer, the real tap cadence, and
    /// collect what the detector said.
    static func feed(_ detector: inout AssistantVoiceActivityDetector,
                     level: Float,
                     seconds: TimeInterval,
                     from start: TimeInterval) -> (events: [AssistantVoiceActivityDetector.Event], end: TimeInterval) {
        var events: [AssistantVoiceActivityDetector.Event] = []
        var now = start
        let step = 0.046
        while now < start + seconds {
            let event = detector.observe(level: level, at: now)
            if event != .none { events.append(event) }
            now += step
        }
        return (events, now)
    }

    static func main() {
        // ── A whole ordinary turn ───────────────────────────────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            // Half a second of room tone first, so the floor settles on the
            // room the way it does in life.
            var clock = 0.0
            (_, clock) = feed(&detector, level: -55, seconds: 0.5, from: clock)

            let (talking, afterTalking) = feed(&detector, level: -20, seconds: 2.0, from: clock)
            precondition(talking.contains(.speechStarted), "two seconds of speech must register as speech")
            precondition(!talking.contains(.speechEnded), "it must not end while somebody is still talking")

            let (quiet, _) = feed(&detector, level: -55, seconds: 2.5, from: afterTalking)
            precondition(quiet.contains(.speechEnded), "silence after speech must end the turn")
        }

        // ── The failure that matters most: never cut somebody off ───────────
        do {
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            (_, clock) = feed(&detector, level: -55, seconds: 0.5, from: clock)
            var events: [AssistantVoiceActivityDetector.Event] = []

            // "how are we doing ... this week": a real mid-sentence pause.
            var chunk = feed(&detector, level: -20, seconds: 1.0, from: clock)
            events += chunk.events; clock = chunk.end
            chunk = feed(&detector, level: -56, seconds: 0.7, from: clock)
            events += chunk.events; clock = chunk.end
            chunk = feed(&detector, level: -20, seconds: 1.0, from: clock)
            events += chunk.events; clock = chunk.end

            precondition(!events.contains(.speechEnded),
                         "a 0.7s thinking pause must not end the turn")
        }

        // ── A turn that opens in silence must WAIT, not end ─────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            let (events, _) = feed(&detector, level: -58, seconds: 10.0, from: 0)
            precondition(!events.contains(.speechEnded),
                         "ten seconds of silence with nothing said must not end a turn")
            precondition(!events.contains(.speechStarted))
            precondition(!detector.hasHeardSpeech)
        }

        // ── A cough is not a turn ───────────────────────────────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            (_, clock) = feed(&detector, level: -55, seconds: 0.5, from: clock)
            let (blip, afterBlip) = feed(&detector, level: -18, seconds: 0.12, from: clock)
            precondition(!blip.contains(.speechStarted), "120ms is a noise, not a sentence")
            let (after, _) = feed(&detector, level: -55, seconds: 3.0, from: afterBlip)
            precondition(!after.contains(.speechEnded), "a noise must not end a turn nobody started")
        }

        // ── One turn reports its end exactly once ───────────────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            (_, clock) = feed(&detector, level: -55, seconds: 0.5, from: clock)
            var chunk = feed(&detector, level: -20, seconds: 1.0, from: clock)
            clock = chunk.end
            chunk = feed(&detector, level: -55, seconds: 6.0, from: clock)
            let ends = chunk.events.filter { $0 == .speechEnded }.count
            precondition(ends == 1, "submitting the same sentence twice is worse than not submitting it")
        }

        // ── A loud room still works, because the floor moves ────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            // A car, or a cafe. A fixed threshold would either never trigger
            // here or would trigger constantly.
            (_, clock) = feed(&detector, level: -34, seconds: 1.5, from: clock)
            let (talking, afterTalking) = feed(&detector, level: -14, seconds: 1.5, from: clock)
            precondition(talking.contains(.speechStarted), "speech must clear a noisy room")
            let (quiet, _) = feed(&detector, level: -34, seconds: 2.5, from: afterTalking)
            precondition(quiet.contains(.speechEnded), "back to room level must end the turn")
        }

        // ── A new turn reuses the room, not the speech ──────────────────────
        do {
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            (_, clock) = feed(&detector, level: -55, seconds: 0.5, from: clock)
            var chunk = feed(&detector, level: -20, seconds: 1.0, from: clock)
            clock = chunk.end
            chunk = feed(&detector, level: -55, seconds: 2.5, from: clock)
            clock = chunk.end
            precondition(chunk.events.contains(.speechEnded))

            let learnedFloor = detector.noiseFloor
            detector.beginTurn()
            precondition(!detector.hasHeardSpeech, "a new turn has heard nothing yet")
            precondition(abs(detector.noiseFloor - learnedFloor) < 0.001,
                         "the room did not change between sentences")

            chunk = feed(&detector, level: -20, seconds: 1.0, from: clock)
            precondition(chunk.events.contains(.speechStarted), "the next turn must work too")
        }

        // ── Noise that STARTS after calibration is absorbed, not answered ───
        do {
            // Calibrated in a quiet room, then a fan, a TV or a passing lorry
            // starts and does not stop. Without a floor that rises while
            // something is loud, this reads as somebody talking forever and
            // the microphone never closes: the exact bug, in a different room.
            var detector = AssistantVoiceActivityDetector()
            var clock = 0.0
            (_, clock) = feed(&detector, level: -58, seconds: 0.5, from: clock)

            // Real speech first, so there is a turn in progress to end.
            var chunk = feed(&detector, level: -18, seconds: 1.0, from: clock)
            precondition(chunk.events.contains(.speechStarted))
            clock = chunk.end

            // Now the person stops, but the room does not go back to quiet.
            chunk = feed(&detector, level: -38, seconds: 20.0, from: clock)
            precondition(chunk.events.contains(.speechEnded),
                         "sustained new noise must be absorbed into the floor, not held as speech")
        }

        // ── Silence measures RMS, not nothing ───────────────────────────────
        do {
            var silence = [Float](repeating: 0, count: 512)
            let quiet = silence.withUnsafeBufferPointer {
                AssistantVoiceActivityDetector.level(samples: $0.baseAddress!, count: 512)
            }
            precondition(quiet <= -100, "digital silence must read as very quiet")
            precondition(quiet.isFinite, "and must stay finite, or every comparison after it breaks")

            for index in 0..<silence.count {
                silence[index] = sin(Float(index) * 0.2) * 0.5
            }
            let loud = silence.withUnsafeBufferPointer {
                AssistantVoiceActivityDetector.level(samples: $0.baseAddress!, count: 512)
            }
            precondition(loud > -20, "a half scale tone must read loud")
        }

        print("Assistant voice activity smoke: OK")
    }
}
