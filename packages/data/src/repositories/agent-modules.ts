import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { KillSwitchRow } from '../schema/admin.js';
import type { AgentJobFireRow, AgentJobRequestRow, AgentJobScheduleRow, AgentPolicyCurrentRow, AgentPolicyVersionRow } from '../schema/agent-modules.js';
import type { CommandContext } from './admin.js';

/**
 * Agent module registry repository (AGT-003, migration packages/data/migrations/agent-modules).
 *
 * - **Staff commands** under `withPrincipal` with a `CommandContext` (BE-004 elevation): recording a validated policy
 *   draft and engaging an agent kill switch call SECURITY DEFINER commands that authorize at the hub and audit in the same
 *   transaction. Activation goes through HUB-001's `hubs_activate_config`; this migration's hook refuses an `agents`
 *   version it did not validate or whose preview went stale.
 * - **Reads** under row-level security: staff of a hub read its policy versions; every signed-in session reads the
 *   current policy (the hub's agent product); a principal reads their own job requests, schedules and firings. Nothing
 *   here lets staff read one participant's agent.
 * - **Worker** entry points: due time-based jobs and recording a firing.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);

async function one<T>(rows: Promise<{ rows: T[] }>, what: string): Promise<T> {
  const row = (await rows).rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export type DispatchRefusal = { kind: string; id: string | null };
export interface PreviewCountsRow { mandates: number | null; jobSubscriptions: number | null; connections: number | null; openRuns: number | null }

export const agentPolicies = {
  /** Cohort counts and exact attribution digest from one restricted snapshot; unknown provenance refuses. */
  async previewSnapshot(trx: Transaction, hubId: string, moduleKeys: readonly string[]): Promise<{ affected: PreviewCountsRow; attributionDigest: string }> {
    const row = await one(sql<{ value: { affected: PreviewCountsRow; attributionDigest: string } }>`SELECT trustwork.agent_modules_preview_snapshot(${hubId}::uuid, ${[...moduleKeys]}::text[]) AS value`.execute(trx), 'agent_modules_preview_snapshot');
    return row.value;
  },
  /** AGT-003's validation of a drafted `agents` configuration version (same transaction as the HUB-001 draft). */
  recordDraft(trx: Transaction, ctx: CommandContext, hubId: string, configVersionId: string, document: unknown): Promise<AgentPolicyVersionRow> {
    return one(sql<AgentPolicyVersionRow>`SELECT * FROM trustwork.agent_modules_record_draft(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${configVersionId}::uuid, ${JSON.stringify(document)}::jsonb)`.execute(trx), 'agent_modules_record_draft');
  },
  /** Cohort counts of active mandates, job subscriptions, connections and open runs in these modules (staff readers only). */
  async previewCounts(trx: Transaction, hubId: string, moduleKeys: readonly string[]): Promise<PreviewCountsRow> {
    const row = await one(sql<{ c: PreviewCountsRow }>`SELECT trustwork.agent_modules_preview_counts(${hubId}::uuid, ${[...moduleKeys]}::text[]) AS c`.execute(trx), 'agent_modules_preview_counts');
    return row.c;
  },
  /** Staff covering the hub with an agent-product permission (never a reader of one participant's agent). */
  async staffReader(trx: Transaction, hubId: string): Promise<boolean> {
    return (await one(sql<{ ok: boolean }>`SELECT trustwork.agent_modules_staff_reader(${hubId}::uuid) AS ok`.execute(trx), 'agent_modules_staff_reader')).ok;
  },
  version(trx: Transaction, configVersionId: string): Promise<AgentPolicyVersionRow | undefined> {
    return trx.selectFrom('agent_policy_version').selectAll().where('config_version_id', '=', configVersionId).executeTakeFirst();
  },
  versions(trx: Transaction, hubId: string): Promise<AgentPolicyVersionRow[]> {
    return trx.selectFrom('agent_policy_version').selectAll().where('hub_id', '=', hubId).orderBy('created_at', 'desc').execute();
  },
  current(trx: Transaction, hubId: string): Promise<AgentPolicyCurrentRow | undefined> {
    return trx.selectFrom('agent_policy_current').selectAll().where('hub_id', '=', hubId).executeTakeFirst();
  },
};

export const agentAuthority = {
  /** First engaged switch or stop that blocks this dispatch (`null` when none). Fail-closed for a null hub. */
  async dispatchRefusal(trx: Transaction, target: { hubId: string | null; moduleKey: string; capabilityId: string | null; action: string | null; personId: string; connectionId: string | null; representativeOf: string | null }): Promise<DispatchRefusal | null> {
    const row = await one(sql<{ r: DispatchRefusal | null }>`SELECT trustwork.agent_modules_dispatch_refusal(${target.hubId}::uuid, ${target.moduleKey}::text, ${target.capabilityId}::text, ${target.action}::text,
      ${target.personId}::uuid, ${target.connectionId}::uuid, ${target.representativeOf}::uuid) AS r`.execute(trx), 'agent_modules_dispatch_refusal');
    return row.r;
  },
  async companyVerified(trx: Transaction, companyId: string): Promise<boolean> {
    const row = await trx.selectFrom('company').select('claim_status').where('id', '=', companyId).executeTakeFirst();
    return row?.claim_status === 'verified';
  },
};

export const agentKillSwitches = {
  /** Engages an agent switch at the hub (admin.agents.kill): immediate, one person, audited. */
  engage(trx: Transaction, ctx: CommandContext, hubId: string, scopeKind: string, target: { moduleKey?: string; capabilityId?: string; action?: string }): Promise<KillSwitchRow> {
    return one(sql<KillSwitchRow>`SELECT * FROM trustwork.admin_engage_kill_switch(${ctxJson(ctx)}::jsonb, ${scopeKind}, NULL::uuid, ${hubId}::uuid, ${JSON.stringify(target)}::jsonb, NULL::uuid)`.execute(trx), 'admin_engage_kill_switch');
  },
  /** Needs a consumed approval of `kill_switch.release` for exactly this release, requested by the releaser. */
  release(trx: Transaction, ctx: CommandContext, killSwitchId: string, approvalId: string, incidentNote: string): Promise<KillSwitchRow> {
    return one(sql<KillSwitchRow>`SELECT * FROM trustwork.admin_release_kill_switch(${ctxJson(ctx)}::jsonb, ${killSwitchId}::uuid, ${approvalId}::uuid, ${incidentNote})`.execute(trx), 'admin_release_kill_switch');
  },
  get(trx: Transaction, id: string): Promise<KillSwitchRow | undefined> {
    return trx.selectFrom('kill_switch').selectAll().where('id', '=', id).executeTakeFirst();
  },
  /** Agent switches in force for a hub (and the node-wide ones). */
  engaged(trx: Transaction, hubId: string): Promise<KillSwitchRow[]> {
    return trx.selectFrom('kill_switch').selectAll().where('state', '=', 'engaged')
      .where((eb) => eb.or([eb('scope_kind', '=', 'node'), eb.and([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['hub_agent_dispatch', 'agent_module', 'agent_capability', 'agent_action', 'external_agent_api', 'outbound_messages'])])]))
      .orderBy('engaged_at').execute();
  },
};

export interface JobRequestInput {
  principal_person_id: string;
  on_behalf_company_id: string | null;
  hub_id: string | null;
  module_key: string;
  template_key: string;
  trigger: unknown;
  goal_id: string | null;
  on_closed_day: 'skip' | 'next_open_day' | 'run';
  proposal_id: string;
  first_due_at: Date | null;
}

export const agentJobs = {
  /** The pending side of "turn this job on" (runs as the principal; the proposal must be their own pending template proposal). */
  insertRequest(trx: Transaction, input: JobRequestInput): Promise<AgentJobRequestRow> {
    return trx.insertInto('agent_job_request').values({ ...input, trigger: JSON.stringify(input.trigger) }).returningAll().executeTakeFirstOrThrow();
  },
  requests(trx: Transaction, personId: string): Promise<AgentJobRequestRow[]> {
    return trx.selectFrom('agent_job_request').selectAll().where('principal_person_id', '=', personId).orderBy('created_at', 'desc').execute();
  },
  request(trx: Transaction, id: string): Promise<AgentJobRequestRow | undefined> {
    return trx.selectFrom('agent_job_request').selectAll().where('id', '=', id).executeTakeFirst();
  },
  schedules(trx: Transaction, personId: string): Promise<AgentJobScheduleRow[]> {
    return trx.selectFrom('agent_job_schedule').selectAll().where('principal_person_id', '=', personId).execute();
  },
  fires(trx: Transaction, subscriptionId: string): Promise<AgentJobFireRow[]> {
    return trx.selectFrom('agent_job_fire').selectAll().where('job_subscription_id', '=', subscriptionId).orderBy('fired_at', 'desc').execute();
  },
  /** The principal asks for a run now; same rechecks as a scheduled firing. */
  async requestRun(trx: Transaction, subscriptionId: string, hubId: string | null): Promise<string> {
    return (await one(sql<{ o: string }>`SELECT trustwork.agent_modules_request_run(${subscriptionId}::uuid, ${hubId}::uuid) AS o`.execute(trx), 'agent_modules_request_run')).o;
  },
};

export interface DueJobRow { job_subscription_id: string; hub_id: string | null; due_at: Date; trigger: unknown; on_closed_day: 'skip' | 'next_open_day' | 'run'; anchor: Date; calendar: unknown }
export const agentJobWorker = {
  /** Persist every currently authorized goal horizon offset, invalidating obsolete pending revisions. */
  async syncGoalDeadlines(trx: Transaction, subscriptionId: string): Promise<number> {
    return (await one(sql<{ n: number }>`SELECT trustwork.agent_modules_sync_goal_deadlines(${subscriptionId}::uuid) AS n`.execute(trx), 'agent_modules_sync_goal_deadlines')).n;
  },
  async due(trx: Transaction, limit: number): Promise<DueJobRow[]> {
    return (await sql<DueJobRow>`SELECT * FROM trustwork.agent_modules_due_jobs(${limit}::integer)`.execute(trx)).rows;
  },
  async recordFire(trx: Transaction, input: { subscriptionId: string; cause: 'schedule' | 'deadline' | 'event' | 'goal' | 'request'; dueAt: Date; nextDueAt: Date | null; hubId: string | null }): Promise<string> {
    return (await one(sql<{ o: string }>`SELECT trustwork.agent_modules_record_fire(${input.subscriptionId}::uuid, ${input.cause}::text, ${input.dueAt}::timestamptz, ${input.nextDueAt}::timestamptz, ${input.hubId}::uuid) AS o`.execute(trx), 'agent_modules_record_fire')).o;
  },
};
