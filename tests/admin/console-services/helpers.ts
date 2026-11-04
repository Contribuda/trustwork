import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { ConsoleSearchResultSchema, ConsoleWorkListSchema, type ConsoleSearchHit, type ConsoleWorkItem, type ConsoleWorkView } from '../../../packages/contracts/src/console-services.js';
import { staffRoleDefinitions, type StaffScope } from '../../../packages/data/src/repositories/admin.js';
import { consoleReads } from '../../../packages/data/src/repositories/console-services.js';
import type { Client, Harness } from '../../backend/helpers/app.js';
import { buildHttpWorld, type AdminWorldHttp } from '../helpers.js';

/**
 * The ADM-001 HTTP world with what ADM-005 needs on top: two read-only roles the shared test definitions do not have, one
 * person for each, and direct seeding of the objects no route of the shared world creates. Everything is synthetic.
 *
 * - `steward`: data-steward at the served hub (pipelines and hub configuration, nothing else).
 * - `recovery`: trust-reviewer at the served hub, who may decide account recovery.
 */
export interface ConsoleWorld extends AdminWorldHttp {
  hubId: string;
  otherHubId: string;
  steward: string;
  recovery: string;
  /** Reads as the person under the runtime role, through the same functions the API calls. */
  searchAs(personId: string, ref: { id?: string; number?: string; key?: string }, target?: StaffScope): Promise<unknown[]>;
  workAs(personId: string, view: ConsoleWorkView, target?: StaffScope): Promise<ConsoleWorkItem[]>;
}

export async function buildConsoleWorld(h: Harness): Promise<ConsoleWorld> {
  const w = await buildHttpWorld(h);
  const { hubId, otherHubId } = w.world;
  const hub = { kind: 'hub', hubId } as const;
  const [steward, recovery] = await w.actors.owner(async (trx) => {
    await staffRoleDefinitions.release(trx, { version: 1, role: 'data-steward', scopes: ['platform', 'node', 'hub'], permissions: ['admin.pipelines.read', 'admin.hub.read'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    await staffRoleDefinitions.release(trx, { version: 1, role: 'trust-reviewer', scopes: ['platform', 'node', 'hub'], permissions: ['admin.support.recovery.rebind', 'admin.support.second_factor.reset'], caps: { creditCapMinorUnits: null, grantMaxHours: 72 }, sodConflicts: [], sodMode: 'reduced', releasedBy: null });
    const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
    return [await person('Synthetic Data Steward'), await person('Synthetic Recovery Reviewer')];
  });
  await w.actors.assign({ personId: steward, role: 'data-steward', scope: hub });
  await w.actors.assign({ personId: recovery, role: 'trust-reviewer', scope: hub });
  return {
    ...w, hubId, otherHubId, steward, recovery,
    searchAs: (personId, ref, target = hub) => w.actors.as(personId, (trx) => consoleReads.search(trx, ref, target)),
    workAs: async (personId, view, target = hub) => (await w.actors.as(personId, (trx) => consoleReads.workItems(trx, view, target))) as ConsoleWorkItem[],
  };
}

/** The lookup over HTTP: always 200, strictly the contract's shape, and the raw body for byte comparison. */
export async function search(client: Client, ref: string, target: { hubId?: string; nodeId?: string } = {}): Promise<{ hits: ConsoleSearchHit[]; raw: string }> {
  const query = new URLSearchParams({ ref, ...target });
  const response = await client.get(`/v1/admin/console/search?${query.toString()}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { hits: ConsoleSearchResultSchema.parse(response.body).hits, raw: JSON.stringify(response.body) };
}

export async function work(client: Client, view: ConsoleWorkView, hubId: string): Promise<ConsoleWorkItem[]> {
  const response = await client.get(`/v1/admin/console/work?view=${view}&hubId=${hubId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return ConsoleWorkListSchema.parse(response.body).items;
}

export const kinds = (hits: { kind: string }[]): string[] => hits.map((x) => x.kind);
export const ids = (rows: { id: string }[]): string[] => rows.map((x) => x.id);

/** A pipeline with one run and, when asked, an alert someone acknowledged, in the named hub. */
export async function seedPipeline(w: ConsoleWorld, hubId: string, acknowledgedBy: string): Promise<{ runId: string; alertId: string }> {
  return w.actors.owner(async (trx) => {
    const { rows: [pipeline] } = await sql<{ id: string }>`INSERT INTO trustwork.pipeline (hub_id, kind, name, created_by) VALUES (${hubId}::uuid, 'source_ingestion', 'Synthetic pipeline', ${w.people.owner}::uuid) RETURNING id`.execute(trx);
    const { rows: [version] } = await sql<{ id: string }>`INSERT INTO trustwork.pipeline_version (pipeline_id, hub_id, version, name, steps, automation_level, drafted_by)
      VALUES (${pipeline?.id}::uuid, ${hubId}::uuid, 1, 'Synthetic pipeline', '[{"id":"fetch","kind":"fetch"}]'::jsonb, 'manual', ${w.people.owner}::uuid) RETURNING id`.execute(trx);
    const { rows: [run] } = await sql<{ id: string }>`INSERT INTO trustwork.pipeline_run (hub_id, pipeline_id, pipeline_version_id, trigger, dry_run, triggered_by)
      VALUES (${hubId}::uuid, ${pipeline?.id}::uuid, ${version?.id}::uuid, 'manual', false, ${w.people.owner}::uuid) RETURNING id`.execute(trx);
    const { rows: [alert] } = await sql<{ id: string }>`INSERT INTO trustwork.pipeline_alert (hub_id, pipeline_id, rule, state, detail, acknowledged_by)
      VALUES (${hubId}::uuid, ${pipeline?.id}::uuid, 'failure_streak', 'acknowledged', 'Synthetic failure streak', ${acknowledgedBy}::uuid) RETURNING id`.execute(trx);
    return { runId: run?.id as string, alertId: alert?.id as string };
  });
}

export async function seedConfigVersion(w: ConsoleWorld, hubId: string): Promise<string> {
  return w.actors.owner(async (trx) => {
    const { rows: [row] } = await sql<{ id: string }>`INSERT INTO trustwork.hub_config_version (hub_id, domain, version, payload, payload_digest, reason, drafted_by)
      VALUES (${hubId}::uuid, 'identity', 1, '{"secretNote":"Synthetic payload text"}'::jsonb, ${randomBytes(32).toString('hex')}, 'Synthetic draft reason', ${w.people.owner}::uuid) RETURNING id`.execute(trx);
    return row?.id as string;
  });
}

/** An approval of `action` with an account servicing action behind it, the way the support workspace opens a recovery. */
export async function seedRecovery(w: ConsoleWorld, input: { subject: string; requestedBy: string; caseId: string }): Promise<string> {
  return w.actors.owner(async (trx) => {
    const digest = randomBytes(32).toString('hex');
    const { rows: [approval] } = await sql<{ id: string }>`INSERT INTO trustwork.second_person_approval (action, scope_kind, hub_id, action_digest, reason, requested_by)
      VALUES ('support.reset_second_factor', 'hub', ${w.hubId}::uuid, ${digest}, 'Synthetic recovery of a named person', ${input.requestedBy}::uuid) RETURNING id`.execute(trx);
    await sql`INSERT INTO trustwork.account_service_action (hub_id, support_case_id, subject_person_id, action, requested_by, reason, evidence_refs, request_digest, approval_id, effective_at, state)
      VALUES (${w.hubId}::uuid, ${input.caseId}::uuid, ${input.subject}::uuid, 'reset_second_factor', ${input.requestedBy}::uuid, 'Synthetic', ARRAY[${randomUUID()}::uuid], ${digest}, ${approval?.id}::uuid, now() + interval '4 days', 'pending')`.execute(trx);
    return approval?.id as string;
  });
}
