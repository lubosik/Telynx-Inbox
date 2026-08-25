import Foundation

/// Deciding, from the microphone alone, when somebody has stopped talking.
///
/// WHY NOT USE THE TRANSCRIPT, WHICH IS WHAT THIS REPLACES
///   The old end-of-speech detector restarted a 1.5 second countdown every time
///   the transcriber produced new text, and ended capture when the countdown
///   ran out. That is only end-of-speech detection if the transcriber emits
///   text WHILE you are speaking. When it emits once, at the end, the countdown
///   is never armed and capture runs until a thirty second timeout, which is
///   exactly what "I have to tap the orb every time I finish" feels like.
///
///   Audio energy does not have that dependency. It is available on every
///   buffer, roughly every 46 milliseconds, whatever the recogniser is doing,
///   and it is what actually distinguishes a person talking from a person not
///   talking. It is also how every telephony voice agent does this.
///
/// THE TWO WAYS THIS CAN BE WRONG, AND THEY ARE NOT EQUALLY BAD
///   Ending too late is a pause. Ending too early cuts somebody off mid
///   sentence, loses what they said, and sends half a question to be answered
///   as though it were whole. So every parameter here is biased towards
///   waiting: a hangover longer than a natural mid-sentence pause, a minimum
///   speech duration so a cough cannot start and end a turn, and an absolute
///   refusal to report the end of speech that never began.
///
/// THE NOISE FLOOR MOVES, BECAUSE ROOMS DIFFER
///   A fixed threshold works in one room. In a car it never triggers, and in a
///   silent office it triggers on the fan. The floor tracks the quietest recent
///   level quickly downwards and rises only very slowly, so it settles on the
///   room rather than on the speech, and a sustained noise it cannot tell from
///   speech will eventually be absorbed into the floor rather than holding the
///   microphone open forever.
struct AssistantVoiceActivityDetector: Equatable {
    enum Event: Equatable {
        case none
        /// The first moment this turn that somebody is definitely talking.
        case speechStarted
        /// They were talking, and have now been quiet long enough to mean it.
        case speechEnded
    }

    // MARK: Tuning

    /// How far above the room's own noise a level must sit to count as speech.
    /// Twelve decibels is about the gap between a room tone and a person
    /// talking at a normal volume a phone's length away.
    var marginAboveFloor: Float = 12

    /// A hard floor underneath the adaptive one. In a truly silent room the
    /// adaptive floor sinks towards the noise floor of the hardware, and
    /// without this a fan starting up would read as somebody speaking.
    var absoluteFloor: Float = -50

    /// How long the quiet has to last. Ordinary speech pauses run to around
    /// three quarters of a second, and the pause before somebody adds "and
    /// actually" is longer. This sits beyond both without feeling dead.
    var hangover: TimeInterval = 1.4

    /// Speech shorter than this is a cough, a door, or a chair. Starting and
    /// ending a turn on one is how the assistant answers a noise.
    var minimumSpeechDuration: TimeInterval = 0.30

    /// How long an unbroken loud run must last before it is treated as the
    /// room rather than as a person.
    ///
    /// Nobody asks their phone a fifteen second question without once dropping
    /// below the threshold, but a fan, a television or a motorway does exactly
    /// that and never stops. Past this point the floor climbs quickly, the
    /// noise is absorbed, and the turn can end. Without it the only thing that
    /// closes the microphone is the thirty second timeout, which then submits
    /// whatever the recogniser made of the noise.
    var sustainedNoiseAfter: TimeInterval = 15

    // MARK: State

    private var floor: Float = -60
    /// Buffers seen before any speech decision is made. The floor starts at a
    /// guess, and a guess that is 20dB below a noisy room classifies the room
    /// itself as speech, which is a microphone that never closes. Measuring
    /// first costs about a third of a second and removes the guess.
    private var calibrationBuffersLeft = 8
    /// When the current unbroken run of "loud" began. A run longer than any
    /// plausible sentence is not a sentence.
    private var loudRunStartedAt: TimeInterval?
    private var speechStartedAt: TimeInterval?
    private var lastLoudAt: TimeInterval?
    private var didReportStart = false
    /// Set once speech has been reported and ended, so a single turn cannot
    /// report ending twice and submit the same sentence two times.
    private var didReportEnd = false

    init() {}

    /// The current room level, for anything that wants to draw it.
    var noiseFloor: Float { floor }
    /// Whether somebody has been heard talking at all this turn.
    var hasHeardSpeech: Bool { didReportStart }

    /// Feed one buffer's level in.
    ///
    /// - Parameters:
    ///   - level: RMS of the buffer in dBFS. Silence is very negative.
    ///   - now: monotonic seconds. Injected so tests need no clock and no audio.
    mutating func observe(level: Float, at now: TimeInterval) -> Event {
        guard level.isFinite else { return .none }

        // Measure the room before judging anything in it.
        if calibrationBuffersLeft > 0 {
            calibrationBuffersLeft -= 1
            floor = calibrationBuffersLeft == 7 ? level : floor + (level - floor) * 0.4
            return .none
        }

        let isLoud = level > max(floor + marginAboveFloor, absoluteFloor)

        // THE FLOOR RISES EVEN WHILE SOMETHING IS LOUD, and that is the part
        // that was missing. Adapting only downwards and during quiet meant a
        // room noisier than the starting guess was classified as speech
        // forever: the floor could never climb to meet it, because climbing
        // was gated on the very quiet it was preventing. A car or a cafe held
        // the microphone open indefinitely.
        //
        // The three rates are deliberately far apart:
        //   fast down     walking somewhere quieter settles in about a second
        //   slow up       a room getting noisier is followed within seconds
        //   very slow up  ten seconds of continuous talking moves the floor by
        //                 a few decibels, nowhere near enough for somebody to
        //                 talk their way above their own threshold and mute
        //                 themselves mid-sentence
        if level < floor {
            floor += (level - floor) * 0.5
        } else if !isLoud {
            floor += (level - floor) * 0.05
        } else if let runStart = loudRunStartedAt, now - runStart > sustainedNoiseAfter {
            // Long past the length of a sentence. Climb fast and absorb it.
            floor += (level - floor) * 0.08
        } else {
            // Ordinary speech. Barely move, so nobody can talk their way above
            // their own threshold and mute themselves mid-sentence.
            floor += (level - floor) * 0.001
        }

        if isLoud {
            if loudRunStartedAt == nil { loudRunStartedAt = now }
            lastLoudAt = now
            if speechStartedAt == nil { speechStartedAt = now }
            if !didReportStart, let started = speechStartedAt,
               now - started >= minimumSpeechDuration {
                didReportStart = true
                return .speechStarted
            }
            return .none
        }

        // Quiet. Only meaningful once somebody has actually spoken: a turn that
        // opens in silence must wait, not end, or the assistant becomes
        // unusable for anybody who takes a moment to think first.
        loudRunStartedAt = nil
        guard didReportStart, !didReportEnd, let lastLoud = lastLoudAt else {
            // A blip too short to count decays back to nothing rather than
            // leaving a stale start time that a much later blip would extend.
            if let started = speechStartedAt, !didReportStart, now - started > minimumSpeechDuration * 2 {
                speechStartedAt = nil
            }
            return .none
        }

        if now - lastLoud >= hangover {
            didReportEnd = true
            return .speechEnded
        }
        return .none
    }

    /// Start a fresh turn. The floor is deliberately KEPT: it describes the
    /// room, which has not changed between one sentence and the next, and
    /// re-learning it every turn would make the first second of every turn
    /// behave differently from the rest.
    mutating func beginTurn() {
        // Calibration is NOT redone. The room is the same room, and spending
        // the first third of a second of every sentence deaf would put the
        // start of every reply at risk.
        speechStartedAt = nil
        lastLoudAt = nil
        loudRunStartedAt = nil
        didReportStart = false
        didReportEnd = false
    }

    /// Root-mean-square level of one buffer, in dBFS.
    ///
    /// Returns a very negative number rather than -infinity for digital
    /// silence, so arithmetic on it stays finite.
    static func level(samples: UnsafePointer<Float>, count: Int) -> Float {
        guard count > 0 else { return -120 }
        var sum: Float = 0
        for index in 0..<count {
            let sample = samples[index]
            sum += sample * sample
        }
        let rms = (sum / Float(count)).squareRoot()
        guard rms > 0.0000001 else { return -120 }
        return 20 * log10(rms)
    }
}
