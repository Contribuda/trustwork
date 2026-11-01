import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { withMaintenance } from '@trustwork/data';
import type { CrashCase } from '../cases.js';
import type { Client, Response } from '../../helpers/app.js';
import { count } from '../../hardening/helpers.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, PASSWORD, signIn } from '../../../admin/helpers.js';

/** Test role definition over the console vocabulary (version 23, unused elsewhere), held at this case's own hub. */
const VERSION = 23;
const PERMISSIONS = ['admin.pipelines.read', 'admin.pipelines.edit', 'admin.pipelines.activate', 'admin.pipelines.run', 'admin.pipelines.pause'];

/**
 * PIPE-001: every pipeline route classified in_transaction, through the BE-005 crash sequence. Steward A creates,
 * drafts, schedules and runs; steward B activates (the drafter never activates), pauses and resumes, cancels and
 * decides the alert. Every person, hub and source is synthetic.
 */
export default {
  name: 'PIPE-001: pipelines, versions, schedules, runs, alerts and role caps',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const hubId = '00000000-0000-4000-8000-00000000c601';
    const people = await withMaintenance(admin, async (trx) => {
      await trx.insertInto('hub').values({ id: hubId, slug: `synthetic-pipe-${randomBytes(2).toString('hex')}`, lifecycle: 'public' }).execute();
      await trx.insertInto('staff_role_definition_version').values({ role: 'data-steward', version: VERSION, scopes: ['hub'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' })
        .onConflict((oc) => oc.doNothing()).execute();
      const founder = await trx.selectFrom('staff_role_assignment').select('person_id').where('setup_bootstrap', '=', true).where('role', '=', 'platform-owner').executeTakeFirstOrThrow();
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const out = { a: await person('Synthetic Crash Pipeline Steward A'), b: await person('Synthetic Crash Pipeline Steward B') };
      for (const id of [out.a, out.b]) {
        await trx.insertInto('staff_role_assignment').values({ person_id: id, role: 'data-steward', scope_kind: 'hub', hub_id: hubId, definition_version: VERSION, granted_by: founder.person_id, reason: 'Synthetic crash test' }).execute();
      }
      return out;
    });
    const email = (k: string) => `crash-pipelines-${k}@example.invalid`;
    await addLogins(h, Object.entries(people).map(([k, id]) => [id, email(k)]));
    const clients = {} as Record<'a' | 'b', Client>;
    for (const key of ['a', 'b'] as const) {
      h.staff.set(people[key], ['data-steward']);
      clients[key] = h.client();
      await signIn(clients[key], email(key));
      const secret = await enrolNow(h, clients[key]);
      h.clock.advance(30_000);
      assert.equal((await clients[key].post('/v1/auth/step-up', { password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const elevated = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(elevated.status, 200, `elevate ${key}: ${JSON.stringify(elevated.body)}`);
      h.clock.reset();
    }
    const { a, b } = clients;
    const body = <T>(r: Response): T => { assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.body)); return r.body as T; };
    const cmd = (action: string, rest: Record<string, unknown>) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const audits = (action: string, objectId?: string) => () => count(admin, `SELECT 1 FROM trustwork.admin_audit_event WHERE action = $1 AND outcome = 'applied' AND hub_id = $2${objectId ? ' AND object_id = $3' : ''}`, objectId ? [action, hubId, objectId] : [action, hubId]);
    const base = `/v1/admin/hubs/${hubId}`;

    const created = body<{ pipeline: { id: string } }>(await run('pipelines.create', a, `${base}/pipelines`, { kind: 'source_ingestion', name: 'Synthetic crash ingestion' },
      () => count(admin, 'SELECT 1 FROM trustwork.pipeline WHERE hub_id = $1', [hubId])));
    const pipelineId = created.pipeline.id;
    const steps = [
      { kind: 'fetch', modelRouteId: null, modelJob: null, settings: {} },
      { kind: 'propose_for_review', modelRouteId: null, modelJob: null, settings: {} },
    ];
    const drafted = body<{ version: { id: string } }>(await run('pipelines.version_draft', a, `${base}/pipelines/${pipelineId}/versions`, {
      name: 'Synthetic crash v1', sourceIds: ['00000000-0000-4000-8000-0000000000aa'], datasetId: null, steps, automationLevel: 'assisted', budgetId: '00000000-0000-4000-8000-0000000000bb',
    }, () => count(admin, 'SELECT 1 FROM trustwork.pipeline_version WHERE pipeline_id = $1', [pipelineId])));
    await run('pipelines.version_activate', b, `${base}/pipeline-versions/${drafted.version.id}/activate`, {}, audits('pipeline.version_activated', drafted.version.id));
    const scheduled = body<{ schedule: { id: string; revision: number } }>(await run('pipelines.schedule_set', a, `${base}/pipelines/${pipelineId}/schedule`, {
      expectedRevision: 0, cron: '15 2 * * 1-5', timeZone: 'America/Chicago', windows: [], jitterSeconds: 0,
      quotas: { maxItemsPerRun: 500, maxRunsPerDay: 1, maxCostPerRun: null, maxRequestsPerMinutePerHost: 30 },
      retry: { maxAttempts: 3, backoff: 'exponential', baseSeconds: 60, maxDelaySeconds: 3600, retryOn: ['network'] }, concurrency: 1, alerts: [],
    }, () => count(admin, 'SELECT 1 FROM trustwork.pipeline_schedule WHERE pipeline_id = $1', [pipelineId])));
    await run('pipelines.schedule_pause', b, `${base}/pipeline-schedules/${scheduled.schedule.id}/pause`, { expectedRevision: scheduled.schedule.revision, pausedReason: 'Synthetic pause' },
      audits('pipeline.schedule_paused', scheduled.schedule.id));
    await run('pipelines.schedule_resume', b, `${base}/pipeline-schedules/${scheduled.schedule.id}/resume`, { expectedRevision: scheduled.schedule.revision + 1 },
      audits('pipeline.schedule_resumed', scheduled.schedule.id));
    const started = body<{ run: { id: string } }>(await run('pipelines.run_start', a, `${base}/pipeline-versions/${drafted.version.id}/runs`, { trigger: 'manual', backfillFrom: null },
      () => count(admin, "SELECT 1 FROM trustwork.pipeline_run WHERE pipeline_id = $1 AND trigger = 'manual'", [pipelineId])));
    await run('pipelines.run_cancel', b, `${base}/pipeline-runs/${started.run.id}/cancel`, {}, audits('pipeline.run_cancelled', started.run.id));
    await run('pipelines.role_cap_set', b, `${base}/pipeline-role-caps`, { role: 'writer', currency: 'USD', dailyCapMinor: '1000' },
      () => count(admin, "SELECT 1 FROM trustwork.pipeline_role_cap WHERE hub_id = $1 AND role = 'writer'", [hubId]));
    // An alert raised by the engine (source change), decided by a person.
    await withMaintenance(admin, async (trx) => {
      const { sql } = await import('kysely');
      await sql`SELECT trustwork.pipelines_source_changed('00000000-0000-4000-8000-0000000000aa'::uuid, 'terms')`.execute(trx);
    });
    const alert = (await admin.query("SELECT id FROM trustwork.pipeline_alert WHERE pipeline_id = $1 AND rule = 'source_changed'", [pipelineId])).rows[0] as { id: string };
    await run('pipelines.alert_decide', b, `${base}/pipeline-alerts/${alert.id}/decide`, { state: 'resolved' }, audits('pipeline.alert_resolved', alert.id));
  },
} satisfies CrashCase;
