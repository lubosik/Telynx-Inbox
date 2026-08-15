# Telynx-Inbox

Vici's shared SMS/MMS and voice inbox, including the web backend/UI and native
iOS application. OpenRouter calls are centralized in
`lib/openrouter-private.js`, which enforces identifier tokenisation, approved
models/providers, ZDR, and data-collection denial. Call recordings are archived
to the private `call-recordings` Supabase bucket and played through an
authenticated short-lived redirect.

Before deploying these privacy controls, apply
`scripts/private-recordings-migration.sql`. Keep
`CALL_RECORDING_RETENTION_ENFORCED=false` until the first destructive retention
dry run has been reviewed and approved.
