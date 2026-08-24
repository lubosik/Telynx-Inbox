# Assistant latency measurement

Status: instrumentation foundation implemented; physical-device thresholds are
not yet certified.

## Product budgets

| Boundary | Target |
|---|---:|
| First audible response | p50 below 2.0 s; p95 below 4.0 s |
| Tool-backed factual answer | p95 below 6.0 s |
| First non-empty speech transcript callback | below 300 ms after that result's audio-range start |
| Voice-driven navigation | screen change below 1.5 s after finalized dictation |

These are gates, not claims that the current build already meets them. Device
measurement remains required because the local host cannot reproduce iPhone
speech assets, audio routes, thermal state or network conditions.

## What is measured now

`AssistantLatencyRecorder` is a process-local main-actor aggregate with an
allowlisted metric enum. It retains at most 200 rolling integer-millisecond samples per metric and
exposes only count, p50 and p95. It uses `systemUptime`, so wall-clock changes do
not corrupt elapsed times. Samples with reversed, non-finite or greater than
five-minute boundaries are rejected.

The iOS 26 speech path anchors the audio timeline immediately before the audio
engine starts. The first non-empty `SpeechTranscriber.Result` callback is
measured from `result.range.start`. The candidate sample is committed only when
dictation finalization succeeds. Cancellation, a business call, audio-route
failure, malformed timing and duplicate callbacks cannot add a sample. The
capture returns the candidate timing to the coordinator; only a matching,
still-current generation with no active call commits it synchronously. This
keeps a detached finalization task from recording after lifecycle cancellation.

`AssistantVoiceOutput` measures from local synthesis enqueue to the matching
utterance's first `AVSpeechSynthesizerDelegate.didStart` callback. This is a
software start proxy, not proof that sound has physically reached the speaker.
An interrupted utterance that never starts adds no sample, and late callbacks
from an older utterance are ignored.

Finalized dictation carries a monotonic completion uptime through an
exactly-once local handoff. The Phase 8 coordinator records voice navigation
only when the exact typed destination reports its authoritative content ready;
router mutation, denial, timeout, cancellation and rollback do not count. A
navigation that requires a human discard decision is excluded from this metric
so human review time cannot corrupt the 1.5-second system budget.

Tool-backed latency begins when an accepted question is submitted and is
recorded only after a permission-checked grounded response returns with at
least one verified citation. Refusals, ungrounded responses, errors and
cancelled generations do not count.

## Privacy boundary

The recorder API accepts only an allowlisted metric and two monotonic numbers.
It has no fields for prompts, transcripts, generated answers, customer or staff
names, phone numbers, IDs, arbitrary labels, or identifier-bearing route
values. It does not log, persist, upload or write samples to `UserDefaults`.

The finalized-dictation text remains in the existing transient local speech
flow; it is not telemetry. Navigation integration must pass only its completion
uptime to the recorder.

## Remaining validation

- A physical iPhone running iOS 26 must collect a representative rolling window
  and compare p50/p95 against the table above.
- First audible output still needs device observation; `didStart` remains
  explicitly labelled as a proxy.
