# Re-screening in the worker (SANC-005)

Every person and company is screened again against each newly activated sanctions list version (a **delta run**), weekly (a **full run**, the safety net) and when a compliance officer asks for it ([ADR 014](../../../../docs/adr/014-sanctions-compliance-engine.md) decision 12; handbook [Sanctions compliance](../../../../docs/engine/modules/sanctions-compliance.md), SNC-F17). Status: **Live** in the worker and the database; the console page that shows runs and the button that asks for one are SANC-006.

## What runs

| Name | Kind | What it does |
|---|---|---|
| `rescreen.on_screening_list_version_activated` | outbox handler | Asks for the delta run of the activated version (one run per version, a duplicate event finds the existing one) and starts it when no run is running |
| `screening.rescreen_batch` (`{ runId }`) | transactional job | One batch of a run (`batch.ts`); enqueues the run's next batch in the same transaction |
| `screening.rescreen_weekly` | task, `RESCREEN_WEEKLY_DAYS` (7) | Asks for the full run; answers the unfinished full run when one exists |
| `screening.rescreen_tick` | task, every minute | Watchdog (a run without a batch in flight fails with an alert; a run past its window raises one `overdue` alert), starts queued runs, resumes failed runs after `RESCREEN_RETRY_MINUTES`, refreshes the cohort gauges |

A compliance officer of the node asks for a full run through `screening_rescreen_request_manual` (repository `rescreenStaff.requestRun`, under a BE-004 elevation, audited as `screening.rescreen_requested`). The API route and the console page come with SANC-006.

## How a run works

- **One run at a time** (a unique index); others queue in order. Within a run exactly one batch is in flight: the batch job enqueues the next one when it commits. While more than `RESCREEN_YIELD_READY_JOBS` jobs of other kinds are due, the next batch waits `RESCREEN_YIELD_SECONDS` (backpressure).
- **Cursor and resumability.** Subjects are walked in a stable order (companies, then persons, by id). A batch locks the run, screens up to `RESCREEN_BATCH` subjects, records results and items, and moves the cursor, all in one transaction. A crash, a lost lease or an error rolls the batch back; the expired lease is reconciled back to the queue and the batch repeats from the committed cursor, so finished subjects are never screened again. A batch that fails for good stops the run (`failed`, alert); the tick resumes it later from its cursor.
- **Delta run, phase `candidates`.** Subjects whose name tokens meet a name key that the new version added or changed (compared with the version it superseded; tokens of the subject's entry types; with the fuzzy layer, a shared token initial) are screened in full first, so a new possible match reaches the review queue as early as possible.
- **Delta run, phase `all`.** Every subject: already screened against every active version with unchanged names is skipped (this is the idempotency per subject and list version); a subject whose last result was a `clear` with no match at all, for the same names, matcher version and fuzzy setting, and whose tokens meet none of the keys its earlier versions lacked, gets a **delta clear** (below); everyone else is screened in full.
- **Full run.** Every subject is matched. A current subject whose outcome is unchanged (`clear` or `insufficient_name` again, same matcher and settings, no match rows) is counted as verified without a new result row; anything else is recorded.
- **Unavailable screening.** With a missing or stale baseline nothing is recorded: the run waits (`blocked_reason = lists_unavailable`) and retries every `RESCREEN_BLOCKED_SECONDS`. Money stays held for every subject not yet screened against the active baseline (`rescreen_due`, `lists_unavailable`).

## Full screening and the delta clear

Full screening is exactly SANC-003's: the same candidates (entries of the subject's types sharing a name-key token or, with the fuzzy layer, a token initial), the same matcher (`packages/compliance/src/matching`) and `screening_record_result`, which rechecks every match, keeps decided entries from being flagged again, refuses a `clear` without every active baseline version, and opens one review case per subject. The worker keeps the entries of the active versions in memory (`entries.ts`; versions are immutable, so the cache never goes stale) instead of asking the database per subject.

A delta clear rests on how the matcher works: it compares each name key of an entry on its own, and an engine-rule match always shares a token with the key (a fuzzy match, a token initial). So if a subject's last result was a `clear` against versions S, for the same names and matcher, the only keys that can change the outcome against the active versions A are the keys in A that S lacked; the worker matches the subject against those keys (the token test). `screening_rescreen_record_delta` then locks the subjects' states and rechecks every other condition (last outcome `clear`, no match row, names digest of the current names, matcher version, fuzzy setting, screened-names digest, screened versions equal to the stated base, the clear names exactly the active versions); the SANC-003 guard still refuses a clear while the baseline is stale. Anything that does not qualify is screened in full. Each delta clear keeps an item naming the base versions. Companies are always screened in full while vessels and aircraft are compared, because a result does not record that setting.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `RESCREEN_BATCH` | 500 | Subjects per batch (50 to 5000) |
| `RESCREEN_WINDOW_HOURS` | 6 | A run unfinished this long after it started raises one `overdue` alert |
| `RESCREEN_WEEKLY_DAYS` | 7 | Interval of the full run (ADR 014 open question 7: weekly or daily) |
| `RESCREEN_RETRY_MINUTES` | 60 | A failed run resumes this long after its last failure |
| `RESCREEN_YIELD_READY_JOBS`, `RESCREEN_YIELD_SECONDS` | 200, 5 | Backpressure |
| `RESCREEN_BLOCKED_SECONDS` | 300 | Retry interval while screening is unavailable |

The fuzzy threshold and the vessel setting are SANC-003's (`SCREENING_FUZZY_THRESHOLD`, `SCREENING_VESSELS_AND_AIRCRAFT`). Until the hub schedule store carries the `sanctions_rescreen` pipeline (HUB-001, HUBC-005), the schedule comes from these variables.

## Metrics and alerts

Hub cohorts only, nobody named:

| Metric | Type | Labels |
|---|---|---|
| `trustwork_rescreen_subjects_total` | counter | `mode`, `method` (`full`, `delta`, `current`, `verified`) |
| `trustwork_rescreen_results_total` | counter | `mode`, `outcome` |
| `trustwork_rescreen_matches_opened_total` | counter | |
| `trustwork_rescreen_runs_finished_total` | counter | `trigger` |
| `trustwork_rescreen_alerts_total` | counter | `kind` (`failed`, `overdue`) |
| `trustwork_rescreen_run_progress_ratio`, `_duration_seconds`, `_subjects_per_minute`, `_matches_opened`, `_overdue` | gauge (database, every tick) | `trigger` (latest run of each) |
| `trustwork_rescreen_run_state` | gauge | `trigger`, `state` |

Alerts: an error log line and the outbox event `screening.rescreen_run_alert` (`{ runId, trigger, alert, mutable: false }`); a finished run appends `screening.rescreen_run_finished` with counts and its duration. Log lines carry run identifiers and counts, never a name, a key or an entry.

## Data

`screening_rescreen_run` (counts, phase, cursor, state; operational) and `screening_rescreen_item` (one per subject and run with a result: method, outcome, base versions of a delta clear; append-only sanctions record), migration `packages/data/migrations/rescreen`, repository `packages/data/src/repositories/rescreen.ts`. The worker has no table grant; compliance officers and auditors of the node read both tables.

## Measured

`node --import tsx tests/rescreen/bench.ts` builds a synthetic hub and times the three kinds of run on the local PostgreSQL; the latest figures are in the SANC-005 pull request.
