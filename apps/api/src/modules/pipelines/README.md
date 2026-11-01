# Pipelines module (PIPE-001)

Hub console routes for the pipeline engine ([automation and scheduling](../../../../../docs/engine/hub-console/automation-and-scheduling.md)). The worker side is in [`apps/worker/src/pipelines`](../../../../worker/src/pipelines/README.md); the tables and commands are in `packages/data/migrations/pipelines`.

| Route | Permission | What it does |
|---|---|---|
| `GET /v1/admin/hubs/:hubId/pipelines` | any `admin.pipelines.*` | Pipelines of the hub |
| `POST …/pipelines` | `admin.pipelines.edit` | Creates a pipeline |
| `GET …/pipelines/:pipelineId` | any | The pipeline with its versions, schedule and last 50 runs |
| `POST …/pipelines/:pipelineId/versions` | `admin.pipelines.edit` | Drafts the next version (checked against the frozen `PipelineVersionSchema` rules) |
| `POST …/pipeline-versions/:versionId/activate` | `admin.pipelines.activate` | Activates a draft; never by its drafter; needs a spending cap; supersedes the active version |
| `POST …/pipelines/:pipelineId/schedule` | `admin.pipelines.edit` | Creates or edits the schedule (each edit a new revision) |
| `POST …/pipeline-schedules/:scheduleId/pause`, `/resume` | `admin.pipelines.pause` | Pause with a reason; resume restarts at the next due time |
| `POST …/pipeline-versions/:versionId/runs` | `admin.pipelines.run` | Starts a manual, dry or backfill run (a dry run may test a draft) |
| `GET …/pipeline-runs/:runId` | any | The run with its effect ledger |
| `POST …/pipeline-runs/:runId/cancel` | `admin.pipelines.run` | Cancels a queued or running run (its pending effects become unknown) |
| `GET …/pipeline-alerts`, `POST …/pipeline-alerts/:alertId/decide` | any / `admin.pipelines.edit` | Alerts; acknowledge or resolve |
| `GET …/pipeline-role-caps`, `POST …/pipeline-role-caps` | any / `admin.pipelines.activate` | Daily caps per agent-team role |

Every route needs a staff role at the hub and a live elevation; every mutation carries the CSRF header, an `Idempotency-Key` restated in the console command body and a staff reason, completes in the request transaction and is audited. A row of another hub answers "not found".
