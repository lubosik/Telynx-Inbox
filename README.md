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

## Revenue analytics

The native iOS app includes an additive Analytics subsystem for messaging,
calling, response performance, customer sentiment and conservative revenue
attribution. Apply `scripts/analytics-migration.sql` before deploying the
Analytics backend. The migration does not change existing source rows.

Read these before evaluating or publishing revenue figures:

- `docs/analytics/REVENUE-ATTRIBUTION-METHODOLOGY.md`
- `docs/analytics/ANALYTICS-ARCHITECTURE.md`
- `docs/analytics/HISTORICAL-REVENUE-ANALYSIS.md`

Historical revenue and sentiment tools are read-only by default:

```bash
node scripts/backfill-analytics.js --report /private/tmp/vici-analytics-review.md --candidate-json /private/tmp/vici-analytics-candidates.json
node scripts/backfill-sentiment.js
```

Neither tool may persist unless it receives both `--persist` and the exact
environment gate `ANALYTICS_BACKFILL_APPROVED=YES` after manual approval. Never
store candidate review files in the repository; although they omit raw PII,
they contain internal order/evidence identifiers. Revenue persistence stages a
complete run and promotes it in one protected database transaction; historical
rows never overwrite a newer live attribution.

Before enabling live attribution, configure Railway `TELNYX_PUBLIC_KEY` with
the account's public Ed25519 key. Existing SMS handling remains compatible when
it is absent, but Analytics deliberately refuses to treat unsigned delivery or
reply webhooks as revenue evidence.
