# Pipelines in the worker (PIPE-001)

The engine runs the versioned pipelines of `packages/data/migrations/pipelines` ([automation and scheduling](../../../../docs/engine/hub-console/automation-and-scheduling.md)).

| Task | Interval | What it does |
|---|---|---|
| `pipelines.schedule` | 60 s | For each active, unpaused schedule, evaluates the cron in the schedule's time zone and queues the latest due time since the last one (no burst after a pause), or records it `skipped_window` outside every window |
| `pipelines.run` | 15 s | Leases queued runs (kill switches and exhausted role caps finish them first) and executes their steps |
| `pipelines.maintenance` | 60 s | Fails runs whose lease expired (pending effects become `unknown`) and queues retries of failed runs after the schedule's backoff |

Step implementations register per step kind on a `PipelineStepRegistry`. A step kind without an implementation fails the run with `pipelines.step_unavailable`; the engine ships no implementation yet, so an activated pipeline fails honestly until its steps exist (source collection, editorial drafting and outreach packages add them).

Inside a step:

- `effect(key, kind, perform)` runs an external effect at most once per key across every run of the pipeline. A key already recorded, whatever its outcome, is skipped; an effect that throws is settled `unknown` and never retried. In a dry run nothing is performed.
- `charge(amountMinor)` charges the step's role (`settings.role`) before a paid call; an exhausted daily cap finishes the run `skipped_budget`.
- `counts` and `carry` hold the run's counters and the data passed between steps (never persisted).

Before every step the run's lease is extended and kill switches are checked; a person's cancellation fences the worker out.
