# Assistant research sources

Accessed 24 August 2026. Only Apple primary documentation is used for Apple
framework decisions.

## Foundation Models

### Foundation Models updates

URL: https://developer.apple.com/documentation/Updates/FoundationModels

Apple's June 2026 update adds the generic LanguageModel protocol,
LanguageModelSession.DynamicProfile, Private Cloud Compute models, and improved
error families to the platform 27 SDK. Those symbols are not in Xcode 26.

Decision for the current Xcode 26 lane: use only the concrete on-device
SystemLanguageModel with LanguageModelSession. Do not create a token conformance,
custom provider, Dynamic Profile, or PCC fallback. Reconsider the generic API
only after an Xcode 27 compile and test lane exists.

### LanguageModel

URL: https://developer.apple.com/documentation/foundationmodels/languagemodel

The platform 27 SDK supports a standard provider protocol for on-device or
server models and an executor that translates framework requests to a provider.

Decision: this is not a Phase 6 API. Vici is not a model provider. Phase 6 uses
one concrete SystemLanguageModel owner plus a small application lifecycle seam
for availability, cancellation, reset, and deterministic tests. That seam does
not conform to or imitate LanguageModel.

### Dynamic sessions and profiles

URL: https://developer.apple.com/documentation/foundationmodels/composing-dynamic-sessions-with-instructions-and-profiles

The platform 27 SDK supports changing models, tools, instructions and generation
options in a continuing session, exactly one active profile, session history
transformation, and lifecycle validation callbacks.

Decision: Dynamic Profiles are deferred. Phase 6 has no tools at all. Future
profiles may minimize model-visible capability but can never be an authorization
boundary; backend RBAC remains mandatory.

### Foundation Models Tool

URL: https://developer.apple.com/documentation/foundationmodels/tool

Supports explicit model tools with typed arguments and output.

Decision: an AppIntent is not automatically a Foundation Models Tool. Both may
use the same deterministic app operation, but each needs its own thin adapter.

### SystemLanguageModel

URL: https://developer.apple.com/documentation/foundationmodels/systemlanguagemodel

Supports the on-device model, runtime availability states, locale support and
model readiness checks.

Decision: availability must be checked at runtime. Hardware names, OS version,
and a successful import are not proof that the model is ready. Typed input and
non-assistant app features must remain available when the model is unavailable.

### Xcode 26 sessions, errors and prompt versions

URLs:

- https://developer.apple.com/documentation/foundationmodels/languagemodelsession/init(model:tools:instructions:)
- https://developer.apple.com/documentation/foundationmodels/languagemodelsession/prewarm(promptprefix:)
- https://developer.apple.com/documentation/foundationmodels/languagemodelsession/respond(to:options:)
- https://developer.apple.com/documentation/foundationmodels/languagemodelsession/generationerror
- https://developer.apple.com/documentation/foundationmodels/updating-prompts-for-new-model-versions

Xcode 26 creates a session with a concrete SystemLanguageModel, an empty tool
array, and trusted Instructions. User text belongs only in Prompt. Apps compiled
with Xcode 26 catch LanguageModelSession.GenerationError; the replacement error
families shown by current documentation require Xcode 27. Prewarm is useful only
with a strong signal at least one second before generation and is not guaranteed
in the background or under system pressure.

Decision: Phase 6 bundles immutable prompt version
`vici-assistant-reasoner-v1.0-ios26`, stores its reviewed SHA-256 and changelog,
and never downloads developer instructions. A strict deterministic scope gate
allows only greetings to reach the model; reviewed local copy handles shell and
privacy questions, and all other requests are declined before model invocation.
The session and its transcript are reset whenever visible private text is purged.
Calls cancel generation, and a generation token rejects late output.

### Private Cloud Compute

URLs:

- https://developer.apple.com/documentation/foundationmodels/adding-server-side-intelligence-with-private-cloud-compute
- https://developer.apple.com/private-cloud-compute/

Supports PrivateCloudComputeLanguageModel on iOS 27 or later, the same session
API as an on-device model, and network, quota, device, entitlement and
eligibility requirements. Qualifying Small Business Program apps below two
million first-time downloads may receive no-cost access.

Decision: PCC is not assumed available or free. It needs the managed
entitlement, qualifying account state, compatible hardware, Apple Intelligence
readiness, network access and remaining quota. If used, the UI must say the
request uses Apple's private cloud rather than calling it on-device.

## App Intents and on-screen context

### Apple Intelligence and Siri

URL: https://developer.apple.com/documentation/appintents/apple-intelligence-and-siri-ai

Supports App Intents integration with Siri, Shortcuts and Spotlight, plus
system schemas for supported domains.

Decision: navigation actions share one typed router operation. App Intents may
adapt that operation for Siri and Shortcuts when the OS and SDK support it.

### Contextual cues and production annotations

URL: https://developer.apple.com/documentation/appintents/providing-contextual-cues-to-apple-intelligence-and-siri

Supports associating visible views with app entities so Siri can resolve
references to on-screen content.

Decision: View Annotations are required for Siri's on-screen reference
resolution. They are not required for Vici's in-app assistant, because the
app-level router can expose its current typed route and selected entity directly.

Production APIs include appEntityIdentifier, appEntityUIElements and
AppEntityUIElement. AppIntentsTesting.ViewAnnotation is a testing
representation, not the production annotation modifier.

### System open schema

URL: https://developer.apple.com/documentation/appintents/appschema/systemintent/open

Decision: use the system open schema where a Vici entity fits it. Do not claim
that every Vici-specific command gains phrase-free Siri understanding.

### App Intents Testing

URLs:

- https://developer.apple.com/documentation/AppIntentsTesting
- https://developer.apple.com/videos/play/wwdc2026/295/

Supports out-of-process tests of intents, entities, queries, Siri, Shortcuts,
Spotlight and view annotations.

Decision: this needs a new UI testing target and an iOS 27/Xcode 27 lane. It
cannot be truthfully validated by the current Xcode 26 workflow.

## Evaluations

URLs:

- https://developer.apple.com/documentation/Evaluations
- https://developer.apple.com/documentation/Evaluations/designing-effective-evaluations
- https://developer.apple.com/videos/play/wwdc2026/299/

Supports datasets, evaluators, metrics, aggregation, code-based checks and
model-as-judge evaluation.

Decision: use Apple's framework for probabilistic assistant quality after an
Xcode 27 lane exists. Keep grounding, RBAC, no-send, prompt-injection, referral
ownership and note isolation in deterministic ordinary tests.

## Speech input

URLs:

- https://developer.apple.com/documentation/speech/speechanalyzer
- https://developer.apple.com/documentation/speech/speechtranscriber
- https://developer.apple.com/documentation/speech/assetinventory
- https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition

Supports live asynchronous transcription, runtime locale and module
availability, managed speech assets, and on-device SpeechAnalyzer transcriber
processing.

Decision: use push-to-talk only in the foreground. Never activate while a
Telnyx call is ringing, connecting or active. Check locale, module and asset
availability and offer typed input when unavailable. Do not silently fall back
to a network speech service. Update the microphone purpose string before
assistant capture.

## Speech output

URLs:

- https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer
- https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoice
- https://developer.apple.com/documentation/avfaudio/avspeechsynthesisvoicequality/premium

Supports enumerating installed voices, default, enhanced and premium quality,
voice-change notification, and nil results for unavailable identifiers.

Decision: never assume a Premium voice is installed or that its enum label
proves it sounds acceptable. Enhanced and Premium assets are user downloads.
The voice decision must be made on a physical pilot device using
VOICE-BENCHMARK.md.

## Toolchain conclusion

The requirements span two SDK generations:

- Xcode 26 can build the app router, referrals, assistant shell,
  AVSpeechSynthesizer, iOS 26 SpeechAnalyzer, and the iOS 26 on-device
  SystemLanguageModel session API.
- Generic LanguageModel provider adoption, Dynamic Profiles, PCC, View
  Annotations, AppIntentsTesting and Evaluations are iOS/Xcode 27 beta work.

The repository's current CI uses macos-26 and the local machine has only Swift
5.8 Command Line Tools. An availability condition cannot make Xcode 26
understand symbols absent from its SDK. Conditional source that CI skips is
also not validation.

Preserve the iOS 16 deployment floor. Build and validate the production router,
referrals, shell and compatible speech pieces first. Add an explicit Xcode 27
compile/test lane before adding or claiming the iOS 27-only integration.
