# Assistant build baseline

Captured 24 August 2026 before feature changes, against commit `8818f91`.

This is the Phase 0 regression reference for the assistant and referral build.
The two live dry runs are aggregate-only and read-only. They wrote no rows,
created no proposals, sent no messages, and sent no notifications.

## Repository baseline

| Check | Result |
|---|---:|
| `npm test` | 1,467 passed, 0 failed |
| JavaScript files in `lib/` and `routes/` | 119 |
| Node test files | 100 |
| Git commit | `8818f91` |
| TestFlight build | 36, from the verified engineering handoff |
| Live contacts | 939 |
| Live buyers | 789 |
| Stored memberships | 1,607 across 10 automatic segments |
| Distinct stored members | 517, from the verified engineering handoff |
| Daily cycle | 06:00 Europe/London |
| Account digest | 08:30 in each account's display time zone, weekdays only |

The engineering handoff recorded 788 buyers earlier on the same date. The live
dry run found 789. This is ordinary source-data growth, not a code change. The
test count and repository file counts match the handoff exactly.

## Daily-cycle dry run

The successful network-enabled run was captured at
`2026-08-24T14:57:18.719Z`.

Schedule and safety state:

- The run ledger migration is applied.
- No cycle has completed yet, so a run today would be treated as a cold start.
- The current clock verdict was `skip`, 597 minutes after the 06:00 target.
- Local dry-run environment delivery flags were off.
- No digest would be sent because the cold-start guard applies.
- All three eligible named accounts still use the workspace-default display
  time zone until they choose their own.

The local `.env` flag report is not evidence of Railway's live variable state.
The engineering handoff separately records that three drafting/digest variables
were enabled in Railway. Future comparisons must compare like with like and
must not treat the local dry-run environment as the deployment configuration.

### Stored versus recomputed membership

| Segment | Stored | Would be | Join | Leave |
|---|---:|---:|---:|---:|
| `one_time_buyers` | 506 | 511 | 6 | 1 |
| `one_time_multi_product` | 324 | 328 | 4 | 0 |
| `one_time_above_typical_spend` | 254 | 256 | 3 | 1 |
| `one_time_lapsed` | 241 | 243 | 2 | 0 |
| `one_time_first_month` | 135 | 139 | 6 | 2 |
| `one_time_slipping` | 130 | 129 | 2 | 3 |
| `reorder_due` | 9 | 26 | 17 | 0 |
| `winback_qualified` | 2 | 9 | 7 | 0 |
| `reorder_approaching` | 2 | 6 | 4 | 0 |
| `reorder_due_high_confidence` | 4 | 4 | 0 | 0 |

Three movements passed the conjoined materiality gate:

- `reorder_due`, delta 17;
- `winback_qualified`, delta 7;
- `reorder_approaching`, delta 4.

The portfolio produced 9 findings and 12 refusals to size. Six findings were
large enough to draft proposals, but the local proposal feature flag was off,
so nothing was drafted.

## Buyer-cohort dry run

Live source shape:

| Metric | Value |
|---|---:|
| Contacts | 939 |
| Buyers | 789 |
| Contacts with no paid order | 150 |
| Paid orders considered | 1,297 |
| One-time buyers | 511, or 64.8% |
| Repeat buyers | 278 |
| Product identities resolved | 2,357 of 2,361 line items |

Orders per buyer:

| Paid orders | Buyers |
|---:|---:|
| 1 | 511 |
| 2 | 158 |
| 3 | 70 |
| 4 | 25 |
| 5 | 10 |
| 6 | 6 |
| 7 | 4 |
| 8 | 2 |
| 9 | 1 |
| 10 | 1 |
| 11 | 1 |

Live cohort populations:

| Cohort | People | Never commercially contacted |
|---|---:|---:|
| `one_time_above_typical_spend` | 256 | 256 |
| `one_time_buyers` | 511 | 511 |
| `one_time_first_month` | 139 | 139 |
| `one_time_lapsed` | 243 | 243 |
| `one_time_multi_product` | 328 | 328 |
| `one_time_slipping` | 129 | 129 |

The frozen calibration still matched the live data:

- half-return point: frozen 33.9 days, live 34.01;
- nine-in-ten return point: frozen 94.3 days, live 94.18;
- typical one-time order value: frozen 169.24 USD, live 169.49 USD;
- one-time buyers: frozen 504, live 511;
- repeat buyers: frozen 277, live 278.

Commercial campaign contacts recorded: 0. The detector therefore correctly
refused every incremental campaign-revenue projection for lack of measured
uplift. Organic return behavior remains a do-nothing baseline, never a claim
of revenue created by the system.

Other live blockers remain unchanged:

- promotional delivery is off;
- no stock-transition history exists;
- 56 one-time buyers have no currently sold matching product;
- contacts with no paid order have no observed conversion value;
- mixed-tenure cohorts refuse a single averaged organic-return rate.

## Phase-boundary rule

At the end of every phase:

1. Run the complete `npm test` suite and require zero failures.
2. Run both live dry runs read-only.
3. Compare the aggregate result with this file.
4. Explain every movement as source-data growth, time passage, or an intentional
   reviewed change. Never silently update this baseline to make a regression
   disappear.
5. Confirm that no message, proposal, notification, or database write occurred
   during the dry-run checks.

The first sandboxed attempts failed only because DNS/network access was blocked.
The same documented read-only scripts succeeded with approved network access.
That sandbox failure is not a product or live-system failure.
