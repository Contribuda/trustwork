import type { z } from 'zod';
import { withPrincipal, type Transaction } from '../../deps/data.js';
import type { ConsolePermission, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  versionProblems, type CreatePipelineCommandSchema, type DecideAlertCommandSchema, type DraftPipelineVersionCommand, type PauseScheduleCommandSchema,
  type ResumeScheduleCommandSchema, type SetPipelineScheduleCommandSchema, type SetRoleCapCommandSchema, type StartRunCommandSchema,
} from './commands.js';
import { adminAudit, pipelines, type CommandContext, type StaffRole } from './deps.js';
import { isAuthorityRefusal, pipelinesRefusal } from './errors.js';
import { toAlert, toEffect, toPipeline, toRoleCap, toRun, toSchedule, toVersion } from './views.js';

type Body<S extends z.ZodType> = z.infer<S>;
type Cmd = { idempotencyKey: string; reason: string };
export interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { hubId: string; permission: ConsolePermission; action: string; objectType: string; objectId: string }
const NO_OBJECT = '00000000-0000-4000-8000-000000000000';

/**
 * Pipeline engine use cases for the hub console (PIPE-001). Every staff command runs in one `PrincipalService.runAs`
 * transaction through a `pipelines_*` SECURITY DEFINER command that checks the permission at the hub, the elevation and
 * separation of duties and writes the audit row in that transaction (BE-005 completes the idempotency record there
 * too). Refusals of authority leave a `denied` audit row in a transaction of their own. Every read checks that the
 * object belongs to the hub in the path; a row of another hub answers "not found".
 */
export class PipelinesService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: 'console_action', reasonText: body.reason };
  }

  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt, fn: (trx: Transaction, cmd: CommandContext, p: Principal) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, cmd, p));
    } catch (error) {
      const refusal = pipelinesRefusal(error);
      if (refusal && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('pipelines.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw pipelinesRefusal(error) ?? error;
    });
  }

  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await trx.selectFrom('staff_role_assignment').select('role').where('person_id', '=', p.personId).where('revoked_at', 'is', null)
        .where((eb) => eb.or([eb('scope_kind', 'in', ['platform', 'node']), eb('hub_id', '=', attempt.hubId)]))
        .where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', new Date())])).orderBy('breakglass').limit(1).executeTakeFirst();
      if (!role) return;
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role.role as StaffRole, scope: { kind: 'hub', hubId: attempt.hubId }, permission: attempt.permission, elevationId: cmd.elevationId,
        action: attempt.action, objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64).replace(/[^a-z0-9_]/g, '_'), reasonText: cmd.reasonText,
        outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  private static ofHub<T extends { hub_id: string }>(row: T | undefined, hubId: string): T {
    if (!row || row.hub_id !== hubId) throw new ApiError('access.not_found', 'access.not_found');
    return row;
  }

  /* ---------- Reads ---------- */

  list(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ items: (await pipelines.list(trx, hubId)).map(toPipeline) }));
  }

  detail(state: RequestState, hubId: string, pipelineId: string) {
    return this.read(state, async (trx) => {
      const pipeline = PipelinesService.ofHub(await pipelines.get(trx, pipelineId), hubId);
      const [versions, schedule, runs] = await Promise.all([pipelines.versions(trx, pipelineId), pipelines.schedule(trx, pipelineId), pipelines.runs(trx, pipelineId, 50)]);
      return { pipeline: toPipeline(pipeline), versions: versions.map(toVersion), schedule: schedule ? toSchedule(schedule) : null, runs: runs.map(toRun) };
    });
  }

  run(state: RequestState, hubId: string, runId: string) {
    return this.read(state, async (trx) => {
      const run = PipelinesService.ofHub(await pipelines.run(trx, runId), hubId);
      return { run: toRun(run), effects: (await pipelines.effects(trx, runId)).map(toEffect) };
    });
  }

  alerts(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ items: (await pipelines.alerts(trx, hubId)).map(toAlert) }));
  }

  roleCaps(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ items: (await pipelines.roleCaps(trx, hubId)).map(toRoleCap) }));
  }

  /* ---------- Commands ---------- */

  create(e: Elevated, hubId: string, body: Body<typeof CreatePipelineCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.edit', action: 'pipeline.create', objectType: 'pipeline', objectId: NO_OBJECT },
      async (trx, cmd) => ({ pipeline: toPipeline(await pipelines.create(trx, cmd, hubId, body.kind, body.name)) }));
  }

  draftVersion(e: Elevated, hubId: string, pipelineId: string, body: DraftPipelineVersionCommand) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.edit', action: 'pipeline.version_draft', objectType: 'pipeline', objectId: pipelineId }, async (trx, cmd, p) => {
      const pipeline = PipelinesService.ofHub(await pipelines.get(trx, pipelineId), hubId);
      const problems = versionProblems(pipeline.kind as Parameters<typeof versionProblems>[0], hubId, p.personId, body);
      if (problems.length > 0) throw new ApiError('validation.schema', problems.join('; '), { reason: 'pipeline_rules', problems });
      const version = await pipelines.draftVersion(trx, cmd, pipelineId, {
        name: body.name, sourceIds: body.sourceIds, datasetId: body.datasetId, steps: body.steps, automationLevel: body.automationLevel, budgetId: body.budgetId,
      });
      return { version: toVersion(version) };
    });
  }

  activateVersion(e: Elevated, hubId: string, versionId: string, body: Cmd) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.activate', action: 'pipeline.version_activate', objectType: 'pipeline_version', objectId: versionId }, async (trx, cmd) => {
      PipelinesService.ofHub(await pipelines.version(trx, versionId), hubId);
      return { version: toVersion(await pipelines.activateVersion(trx, cmd, versionId)) };
    });
  }

  setSchedule(e: Elevated, hubId: string, pipelineId: string, body: Body<typeof SetPipelineScheduleCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.edit', action: 'pipeline.schedule_set', objectType: 'pipeline', objectId: pipelineId }, async (trx, cmd) => {
      PipelinesService.ofHub(await pipelines.get(trx, pipelineId), hubId);
      const schedule = await pipelines.setSchedule(trx, cmd, pipelineId, body.expectedRevision, {
        cron: body.cron, timeZone: body.timeZone, windows: body.windows, jitterSeconds: body.jitterSeconds, quotas: body.quotas, retry: body.retry, concurrency: body.concurrency, alerts: body.alerts,
      });
      return { schedule: toSchedule(schedule) };
    });
  }

  pauseSchedule(e: Elevated, hubId: string, scheduleId: string, body: Body<typeof PauseScheduleCommandSchema> | Body<typeof ResumeScheduleCommandSchema>, pause: boolean) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.pause', action: pause ? 'pipeline.schedule_pause' : 'pipeline.schedule_resume', objectType: 'pipeline_schedule', objectId: scheduleId },
      async (trx, cmd) => {
        const current = await trx.selectFrom('pipeline_schedule').selectAll().where('id', '=', scheduleId).executeTakeFirst();
        PipelinesService.ofHub(current, hubId);
        const reason = pause ? (body as Body<typeof PauseScheduleCommandSchema>).pausedReason : null;
        return { schedule: toSchedule(await pipelines.pauseSchedule(trx, cmd, scheduleId, body.expectedRevision, pause, reason)) };
      });
  }

  startRun(e: Elevated, hubId: string, versionId: string, body: Body<typeof StartRunCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.run', action: 'pipeline.run_start', objectType: 'pipeline_version', objectId: versionId }, async (trx, cmd) => {
      PipelinesService.ofHub(await pipelines.version(trx, versionId), hubId);
      return { run: toRun(await pipelines.startRun(trx, cmd, versionId, body.trigger, body.backfillFrom)) };
    });
  }

  cancelRun(e: Elevated, hubId: string, runId: string, body: Cmd) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.run', action: 'pipeline.run_cancel', objectType: 'pipeline_run', objectId: runId }, async (trx, cmd) => {
      PipelinesService.ofHub(await pipelines.run(trx, runId), hubId);
      return { run: toRun(await pipelines.cancelRun(trx, cmd, runId)) };
    });
  }

  decideAlert(e: Elevated, hubId: string, alertId: string, body: Body<typeof DecideAlertCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.edit', action: 'pipeline.alert_decide', objectType: 'pipeline_alert', objectId: alertId }, async (trx, cmd) => {
      const current = await trx.selectFrom('pipeline_alert').selectAll().where('id', '=', alertId).executeTakeFirst();
      PipelinesService.ofHub(current, hubId);
      return { alert: toAlert(await pipelines.decideAlert(trx, cmd, alertId, body.state)) };
    });
  }

  setRoleCap(e: Elevated, hubId: string, body: Body<typeof SetRoleCapCommandSchema>) {
    return this.staff(e, body, { hubId, permission: 'admin.pipelines.activate', action: 'pipeline.role_cap_set', objectType: 'pipeline_role_cap', objectId: NO_OBJECT },
      async (trx, cmd) => ({ roleCap: toRoleCap(await pipelines.setRoleCap(trx, cmd, hubId, body.role, body.currency, body.dailyCapMinor)) }));
  }
}
