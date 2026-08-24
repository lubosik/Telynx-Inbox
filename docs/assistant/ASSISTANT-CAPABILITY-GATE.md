# Assistant capability gate

The native assistant is off by default and has no server-side model endpoint.
Its only assistant-specific backend route is:

```text
GET /api/assistant/status
```

The route requires `assistant.use`. The additive RBAC catalogue grants that
permission to named Owner and Admin accounts, not Support Agent or legacy
shared accounts. The handler repeats the named Owner/Admin check so an
accidental per-user grant cannot widen the pilot.

`ASSISTANT_ENABLED` must be exactly the lowercase string `true`. Missing,
blank, differently cased, boolean-like, or false values leave the capability
disabled. The endpoint returns only:

```json
{
  "enabled": false,
  "mode": "on_device_read_only",
  "minimumOSMajor": 26,
  "reason": "pilot_disabled"
}
```

The response is private and not cacheable. It contains no business data.

This flag does not grant access to analytics, campaigns, segments, referrals,
activity, contacts, calls, or conversations. Each read-only assistant tool must
call the existing endpoint for its fact, and that endpoint keeps its existing
route-policy permission. No assistant-specific endpoint sends a message,
changes a campaign, changes a segment, acts on a referral, calls a cloud model,
or accepts prompt text.

Clients must check status when the assistant opens, when the app returns to the
foreground, and immediately before a new prompt. A failed status check disables
new prompts. Turning the flag off therefore disables new assistant work without
an app update and without affecting inbox, calling, analytics, or Growth.

## Phase 6 on-device reasoning boundary

After the server and named-account checks pass, the iOS 26 client separately
checks `SystemLanguageModel.default.availability`. Apple Intelligence disabled,
ineligible hardware, model assets not ready, and unknown unavailability each
fail closed without affecting the rest of the app.

Phase 6 gives `LanguageModelSession` no tools and no business records. A
deterministic local allowlist permits only harmless greetings to reach the
model. Assistant and privacy questions use reviewed fixed local answers. Every
other request receives a fixed no-data answer before the model operation can
run. This default-deny gate is necessary because instructions alone cannot
ground an arbitrary model response.

Generated greeting output has a second deterministic boundary before transcript
or speech: after punctuation and case normalization, the complete response must
equal one of a small set of reviewed generic greeting phrases. Anything else,
including a name, fact, number, currency value, or extra claim, becomes the
reviewed fixed response `Hello.`.

The bundled developer instructions are versioned as
`vici-assistant-reasoner-v1.0-ios26`. User input is placed only in `Prompt` and
never in `Instructions`. Prompt text, model responses, and session transcripts
are never sent to the backend, logged, or persisted. Backgrounding, dismissal,
access loss, and calls cancel generation and reset the model session.
