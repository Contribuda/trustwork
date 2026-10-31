# Automation and scheduling

Status: **Proposed**. Contract: `ScheduleSchema`, `CronExpressionSchema`, `RetryPolicySchema`, `AlertRuleSchema`, `PipelineVersionSchema`, `PipelineRunSchema`, `RUN_STATES`, `runTransitionAllowed`, `ProviderBudgetSchema`, `KillSwitchSchema` in [`hub.ts`](../../../packages/contracts/src/hub.ts). Screens HC-110…HC-112 in [screens](screens.md#automation). Backend: proposed PIPE-001 in `apps/worker`.

Every pipeline in the hub (source discovery, ingestion, editorial drafting, translation, magazine assembly, dataset refresh, entity resolution, verification re-checks, sanctions re-screening, index builds) runs on one scheduler with one set of controls. Staff see the same schedule, run history, pause button, dry run and alerts for all of them.

## Pipelines are versioned

A pipeline is a sequence of steps (`PIPELINE_STEPS`), each optionally bound to a model route; it has a kind, sources or a dataset, an automation level, a spending cap and a schedule. Editing creates a new version; runs record the exact version they ran. Rules the contract enforces:

- Content and data pipelines end in `propose_for_review` or `notify_staff`: their output always reaches people.
- Generated content (rewrite, summary, translation, image) must be followed by review; a rewrite must be followed by a similarity check.
- A model step names both its route and its job, and the job must fit the step (a rewrite step cannot use the translation job).
- An active pipeline names a spending cap.
- There is no step that publishes, activates, merges or sanctions.

## Schedules

| Setting | Meaning | Example |
|---|---|---|
| Cron | Five fields (minute hour day-of-month month day-of-week) with ranges, lists and steps; presets for "hourly", "daily at", "weekdays at", "weekly on" | `15 2 * * 1-5` |
| Time zone | IANA zone of the schedule; the console shows next runs in it and in the viewer's zone | `America/Chicago` |
| Windows | Allowed days and hours; a run due outside a window waits for the next window or is recorded as `skipped_window` | Weekdays 01:00–05:00 for crawling, to be polite to small sites |
| Jitter | Random delay so many hubs do not hit the same source at the same second | 5 minutes |
| Quotas | Items per run, runs per day, cost per run, requests per minute per host | 500 items, 1 run, $5.00, 30 requests per minute |
| Retry policy | Attempts (1–10), fixed or exponential backoff, maximum delay, which failures are retried (`network`, `rate_limited`, `server_error`, `timeout`) | 3 attempts, exponential from 60 s |
| Concurrency | Parallel runs of this pipeline (1–4) | 1 |
| Alerts | Failure streak, zero items for N runs (the source probably changed), cost threshold, duration exceeded, source changed (robots or terms digest), cap exhausted; to the console or staff e-mail | 3 empty runs → alert |
| Pause | Paused schedules record who and why | "Waiting for the publisher's reply" |

The `CronField` editor shows a plain-language sentence ("At 02:15, Monday to Friday, Central time") and the next five run times using `Intl` in the viewer's language.

## Runs

```text
queued → running → succeeded | partially_succeeded | failed | cancelled | stopped_by_kill_switch | skipped_budget
queued → skipped_window | skipped_budget | cancelled | stopped_by_kill_switch
```

A run records its trigger (`schedule`, `manual`, `dry_run`, `retry`, `backfill`, `event`), who started it (a person, or the schedule), timing, counts (fetched, new, duplicates, skipped by licence, skipped by robots, proposed, failed), cost, and whether effects were committed. A retry is a **new run** linked to the failed one; finished runs never change state.

### Retries and external effects

Fetching and parsing are idempotent and safe to retry. Steps with external effects are not retried blindly: a model call whose outcome is unknown is recorded with its cost estimate and not repeated within the same run unless the provider confirms it failed; an outbound notification uses the engine's idempotency keys and reconciliation ([architecture](../architecture.md#data-and-reliability)). Paid steps check the spending cap before each call.

### Dry runs

A dry run executes the pipeline without committing anything (`dryRun: true` implies `effectsCommitted: false`): no source records, no editorial items, no index writes, no notifications. Two variants:

- **Dry run with fakes**: model steps use the fake adapter; costs nothing; shows what would be fetched, deduplicated and proposed.
- **Dry run with models**: real model calls on a small sample (bounded by the per-run cost quota); shows draft quality and cost per item before the pipeline goes live.

Dry runs are how a data steward tests a new content-type mapping, a new source, or a pipeline change.

### Backfills

A backfill runs a pipeline over a past period (for example "the last 30 days of SAM.gov notices") as a person-started run with its own quotas and cap.

## Pause, resume and kill

- **Pause** a schedule: no new runs; running runs finish. Resume restarts at the next due time (no burst of missed runs unless "catch up" is chosen, bounded by quotas).
- **Pause a source**: automatic on robots, terms or licence changes, error streaks or takedown; resuming needs a person and a fresh check.
- **Kill switch** on a pipeline or model job: running runs end `stopped_by_kill_switch` at the next step boundary; release needs a second person and an incident note.
- **Caps**: an exhausted cap marks queued runs `skipped_budget` and stops paid steps in running ones.

## Run history and logs

The runs screen filters by pipeline, kind, state, trigger and date; the detail shows each step with duration, counts, model route used, cost and error code, plus links to what the run proposed (review items, import batches, link proposals). Logs never contain secrets, private data or full prompts; run logs follow the operational retention class.

## Alerts

Alerts appear on the overview and the alerts screen with the pipeline, rule, first and last occurrence, and suggested action ("source returned 0 items for 3 runs; its sitemap URL may have changed"). Acknowledging records the person; resolving records the change that fixed it.

## US and non-US example

| Pipeline | US hub schedule | Samarkand hub schedule |
|---|---|---|
| SAM.gov opportunities ingestion | Hourly 06:00–20:00 Eastern, weekdays | — |
| Licence board refresh | Weekly, Sunday 03:00 Central | Monthly (register cadence) |
| Editorial drafting | Weekdays 05:00 Central | Weekdays 06:00 Samarkand |
| Sanctions re-screening | On list update and weekly | Same |
| Magazine assembly | Thursday 14:00 Central for the Friday issue | Wednesday 14:00 for the Thursday issue |
| US federal holidays | Pipelines may skip holidays from the hub calendar (local addition until the US pack exists) | Holidays from the UZ pack |

## Acceptance (when implemented)

- A dry run commits nothing (database diff test).
- A run outside its window is skipped and recorded, never executed.
- A retry never repeats an external effect whose outcome is unknown.
- An exhausted cap or an engaged kill switch stops paid steps at the next boundary.
- A schedule edit creates a new revision; runs keep the version they ran.
