import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext } from './admin.js';
import type { HubConfigVersionRow } from '../schema/hubs.js';
import type { AgentExtensionCallRow, AgentExtensionRow, AgentExtensionSafetyRunRow, AgentExtensionTransitionRow, AgentExtensionVersionRow } from '../schema/agent-extensions.js';
import '../schema/agent-extensions.js';

/**
 * Governed extension registry (AGT-023, migration packages/data/migrations/agent-extensions; contract
 * packages/contracts/src/agent-extensions.ts).
 *
 * - **Reads** under `withPrincipal`: staff of the hub read the registry (row-level security); anyone in the hub reads an
 *   `active` manifest, which is what the hub offers everyone.
 * - **Staff commands**: draft a version, ask for a safety run, propose an activation as a configuration version, suspend
 *   and retire. Activation itself is HUB-001's (`hubConfig.activate`), under the second-person approval.
 * - **Worker commands** (`agentExtensionWorker`): only the worker role loads and completes a run, under its job lease,
 *   and reports the engine version it runs.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
async function one<T>(query: Promise<{ rows: T[] }>, name: string): Promise<T> {
  const { rows } = await query;
  if (!rows[0]) throw new Error(`${name} returned no row`);
  return rows[0];
}

/** One action of a version this hub activated and enabled: what the runtime checks a proposed call against. */
export interface ExtensionActionBinding<A = never> {
  extensionId: string;
  versionId: string;
  version: number;
  manifestDigest: string;
  key: string;
  action: A;
}

export const agentExtensions = {
  /** Null unless the version is active and the hub's agent policy lists it. */
  async action<A>(trx: Transaction, hubId: string, capabilityId: string): Promise<ExtensionActionBinding<A> | null> {
    const { rows } = await sql<{ e: ExtensionActionBinding<A> | null }>`SELECT trustwork.agent_extensions_action(${hubId}::uuid, ${capabilityId}) AS e`.execute(trx);
    return rows[0]?.e ?? null;
  },
  /** The audit of calls, newest first, by digest; `action_intent` stays out of reach (row-level security) and out of the view. */
  calls(trx: Transaction, hubId: string, limit: number): Promise<AgentExtensionCallRow[]> {
    return trx.selectFrom('agent_extension_call').selectAll().where('hub_id', '=', hubId).orderBy('started_at', 'desc').limit(limit).execute();
  },
  async staffReader(trx: Transaction, hubId: string): Promise<boolean> {
    return (await one(sql<{ ok: boolean }>`SELECT trustwork.agent_extensions_staff_reader(${hubId}::uuid) AS ok`.execute(trx), 'agent_extensions_staff_reader')).ok;
  },
  /** Whether the caller may draft in this hub; lets the API refuse before it explains a manifest to someone who may not write one. */
  async mayEdit(trx: Transaction, hubId: string): Promise<boolean> {
    return (await one(sql<{ ok: boolean }>`SELECT trustwork.admin_has_any_permission(ARRAY['admin.agents.extensions.edit', 'admin.config.edit']::text[], NULL::uuid, ${hubId}::uuid) AS ok`.execute(trx), 'admin_has_any_permission')).ok;
  },
  list(trx: Transaction, hubId: string): Promise<AgentExtensionRow[]> {
    return trx.selectFrom('agent_extension').selectAll().where('hub_id', '=', hubId).orderBy('key').execute();
  },
  versions(trx: Transaction, hubId: string): Promise<AgentExtensionVersionRow[]> {
    return trx.selectFrom('agent_extension_version').selectAll().where('hub_id', '=', hubId).orderBy('extension_id').orderBy('version', 'desc').execute();
  },
  version(trx: Transaction, versionId: string): Promise<AgentExtensionVersionRow | undefined> {
    return trx.selectFrom('agent_extension_version').selectAll().where('id', '=', versionId).executeTakeFirst();
  },
  /** The versions a hub offers right now. */
  active(trx: Transaction, hubId: string): Promise<AgentExtensionVersionRow[]> {
    return trx.selectFrom('agent_extension_version').selectAll().where('hub_id', '=', hubId).where('status', '=', 'active').orderBy('extension_id').execute();
  },
  runs(trx: Transaction, hubId: string): Promise<AgentExtensionSafetyRunRow[]> {
    return trx.selectFrom('agent_extension_safety_run').selectAll().where('hub_id', '=', hubId).orderBy('requested_at', 'desc').execute();
  },
  run(trx: Transaction, runId: string): Promise<AgentExtensionSafetyRunRow | undefined> {
    return trx.selectFrom('agent_extension_safety_run').selectAll().where('id', '=', runId).executeTakeFirst();
  },
  transitions(trx: Transaction, versionId: string): Promise<AgentExtensionTransitionRow[]> {
    return trx.selectFrom('agent_extension_transition').selectAll().where('version_id', '=', versionId).orderBy('at').execute();
  },

  draft(trx: Transaction, ctx: CommandContext, hubId: string, manifest: unknown): Promise<AgentExtensionVersionRow> {
    return one(sql<AgentExtensionVersionRow>`SELECT * FROM trustwork.agent_extensions_draft(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${JSON.stringify(manifest)}::jsonb)`.execute(trx), 'agent_extensions_draft');
  },
  requestRun(trx: Transaction, ctx: CommandContext, versionId: string, expectedRevision: number): Promise<AgentExtensionSafetyRunRow> {
    return one(sql<AgentExtensionSafetyRunRow>`SELECT * FROM trustwork.agent_extensions_request_run(${ctxJson(ctx)}::jsonb, ${versionId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agent_extensions_request_run');
  },
  draftActivation(trx: Transaction, ctx: CommandContext, hubId: string, versionIds: readonly string[]): Promise<HubConfigVersionRow> {
    return one(sql<HubConfigVersionRow>`SELECT * FROM trustwork.agent_extensions_draft_activation(${ctxJson(ctx)}::jsonb, ${hubId}::uuid, ${[...versionIds]}::uuid[])`.execute(trx), 'agent_extensions_draft_activation');
  },
  suspend(trx: Transaction, ctx: CommandContext, versionId: string, expectedRevision: number): Promise<AgentExtensionVersionRow> {
    return one(sql<AgentExtensionVersionRow>`SELECT * FROM trustwork.agent_extensions_suspend(${ctxJson(ctx)}::jsonb, ${versionId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agent_extensions_suspend');
  },
  retire(trx: Transaction, ctx: CommandContext, versionId: string, expectedRevision: number): Promise<AgentExtensionVersionRow> {
    return one(sql<AgentExtensionVersionRow>`SELECT * FROM trustwork.agent_extensions_retire(${ctxJson(ctx)}::jsonb, ${versionId}::uuid, ${expectedRevision}::integer)`.execute(trx), 'agent_extensions_retire');
  },
};

export interface ExtensionRunTarget {
  runId: string;
  state: 'requested' | 'passed' | 'failed';
  versionId: string;
  extensionId: string;
  hubId: string;
  manifest: unknown;
  manifestDigest: string;
  /** The built-in confirmations of the running engine. */
  builtIn: { mandateAction: string; confirmation: string }[];
}

export type ExtensionCallStart = { callId: string; refusal: string | null; connectionMode: 'fake' | 'live' | null };

export const agentExtensionWorker = {
  /** Before `enterEffect`: the gate's lock comes before the authorization epochs, as in every writer of a kill switch. */
  async lockGate(trx: Transaction): Promise<void> {
    await sql`SELECT trustwork.agent_extensions_lock_gate()`.execute(trx);
  },
  async beginCall(trx: Transaction, attemptId: string, jobId: string, fencingToken: string | number, inputDigest: string): Promise<ExtensionCallStart> {
    const { rows } = await sql<{ r: ExtensionCallStart }>`SELECT trustwork.agent_extensions_begin_call(${attemptId}::uuid, ${jobId}::uuid, ${fencingToken}::bigint, ${inputDigest}::text) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async finishCall(trx: Transaction, callId: string, outcome: 'succeeded' | 'failed' | 'refused' | 'unknown', outputDigest: string | null, refusal: string | null = null): Promise<void> {
    await sql`SELECT trustwork.agent_extensions_finish_call(${callId}::uuid, ${outcome}::text, ${outputDigest}::text, ${refusal}::text)`.execute(trx);
  },
  async recordReconciled(trx: Transaction, attemptId: string, outcome: 'succeeded' | 'failed', outputDigest: string | null): Promise<void> {
    await sql`SELECT trustwork.agent_extensions_record_reconciled(${attemptId}::uuid, ${outcome}::text, ${outputDigest}::text)`.execute(trx);
  },
  async loadRun(trx: Transaction, runId: string, jobId: string, fencingToken: string | number): Promise<ExtensionRunTarget> {
    const { rows } = await sql<{ r: ExtensionRunTarget }>`SELECT trustwork.agent_extensions_load_run(${runId}::uuid, ${jobId}::uuid, ${fencingToken}::bigint) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async recordRun(trx: Transaction, runId: string, jobId: string, fencingToken: string | number, report: unknown): Promise<string> {
    const { rows } = await sql<{ r: string }>`SELECT trustwork.agent_extensions_record_run(${runId}::uuid, ${jobId}::uuid, ${fencingToken}::bigint, ${JSON.stringify(report)}::jsonb) AS r`.execute(trx);
    return rows[0]!.r;
  },
  async engineTick(trx: Transaction, engineVersion: string, limit = 100, deadlineSeconds = 3600): Promise<number> {
    const { rows } = await sql<{ n: number }>`SELECT trustwork.agent_extensions_engine_tick(${engineVersion}::text, ${limit}::integer, ${deadlineSeconds}::integer) AS n`.execute(trx);
    return rows[0]?.n ?? 0;
  },
};
