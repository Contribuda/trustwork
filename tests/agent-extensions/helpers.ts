import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DataPool } from '@trustwork/data';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION, type ConsolePermission } from '@trustwork/contracts';
import { HandlerRegistry, JobRunner, Metrics, workerConfigFromEnv } from '@trustwork/worker';
import type { AgentExtensionManifest } from '../../packages/contracts/src/agent-extensions.js';
import { egressAllowDigestInput } from '../../packages/contracts/src/providers.js';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { egressRules, modelRoutes, providerConnections } from '../../packages/data/src/repositories/providers.js';
import { ENGINE_EXTENSION_ADAPTERS, registerExtensionSafetyRuns, type ExtensionRuntime, type InstalledExtensionAdapter } from '../../apps/worker/src/agent-extensions/index.js';
import { silentLogger } from '../../apps/worker/src/log.js';
import { workerLogin } from '../assistant/helpers.js';
import { buildAgentWorld, command, ok, type AgentWorld } from '../agent-modules/helpers.js';
import { activateResidency, SELF_US } from '../providers/helpers.js';
import type { Client, Harness, Response } from '../backend/helpers/app.js';

/**
 * Synthetic world of the AGT-023 suites: the AGT-003 staff world (hub owner and compliance officer hold the extension and
 * provider permissions, a moderator holds none), a fake provider connection, and a real worker role that runs safety
 * suites through job leases. Every person, hub, endpoint and adapter is synthetic.
 */
const PERMISSIONS: ConsolePermission[] = [
  'admin.agents.extensions.edit', 'admin.agents.extensions.activate', 'admin.agents.extensions.suspend', 'admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.test',
  'admin.providers.toggle', 'admin.providers.egress.edit', 'admin.models.route.edit', 'admin.models.route.activate', 'admin.hub.residency.edit',
];
export const ENGINE = '0.1.0';
export { lookup, manifestOf } from './manifests.js';

export interface VersionBody { version: { ref: { id: string; extensionId: string; status: string; version: number; approvedBy: string | null; activatedConfigVersionId: string | null; safetySuite: { passed: boolean; engineVersion: string } | null; manifestDigest: { value: string } }; revision: number; statusReason: string | null; latestRun: { id: string; state: string; failedCount: number } | null } }
export interface ActivationBody { activation: { configVersionId: string; revision: number; payload: { activeVersions: { versionId: string }[] }; activation: { secondPersonAction: string; actionDigest: string } } }
export type CommandBody = { result: { outcome: string; approvalRequestId: string | null; objectId: string; revision: number } };

export interface ExtensionWorld extends AgentWorld {
  admin: Harness['db']['admin'];
  base: string;
  connectionId: string;
  /** Runs every queued job through a real lease under the worker role. */
  drain(): Promise<void>;
  runtime: ExtensionRuntime;
  installAdapters(adapters: readonly InstalledExtensionAdapter[]): void;
  close(): Promise<void>;
}

export async function buildExtensionWorld(h: Harness): Promise<ExtensionWorld> {
  const world = await buildAgentWorld(h, PERMISSIONS);
  const { a, w, hubId } = world;
  await activateResidency(a, w.people.owner, w.people.officer, hubId, ['US']);
  const connection = await a.cmd(w.people.owner, (trx, ctx) => providerConnections.create(trx, ctx, hubId, {
    adapterId: 'fake', mode: 'fake', label: 'Synthetic extension connection', capabilities: ['llm'], endpoint: null, hosting: SELF_US, storageCountry: null, region: null, credentialRefId: null,
  }));
  const material = await a.cmd(w.people.owner, (trx, ctx) => providerConnections.testMaterial(trx, ctx, connection.id));
  await a.cmd(w.people.owner, (trx, ctx) => providerConnections.recordTest(trx, ctx, connection.id, { configDigest: material.config_digest, outcome: 'ok', latencyMs: 1, modelsListed: 1, cost: null, probeDigest: 'a'.repeat(64), secretRefId: null }));
  await a.cmd(w.people.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, connection.id, (await providerConnections.get(trx, connection.id))!.revision, null));
  await a.cmd(w.people.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: connection.id, dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null }));

  const login = await workerLogin(h);
  const pool: DataPool = login.pool(3);
  const runtime: ExtensionRuntime = { pool, engineVersion: ENGINE, adapters: ENGINE_EXTENSION_ADAPTERS, log: silentLogger };
  const registry = new HandlerRegistry();
  registerExtensionSafetyRuns(registry, runtime);
  const config = workerConfigFromEnv({ WORKER_DATABASE_URL: 'postgresql://unused', WORKER_ID: 'synthetic-extensions', WORKER_CONCURRENCY: '1' }).config;
  const runner = new JobRunner({ pool, registry, config, metrics: new Metrics(), log: silentLogger });
  return {
    ...world, admin: h.db.admin, base: `/v1/admin/agent-extensions/${hubId}`, connectionId: connection.id, runtime,
    installAdapters(adapters) { runtime.adapters = adapters; },
    async drain() { for (let i = 0; i < 20 && await runner.tick(); i++) await runner.idle(); },
    close: () => login.close(),
  };
}

/** A route of this extension, active. Private classes need the second person, as for every route. */
export async function activateRoute(x: ExtensionWorld, extensionId: string, classes: string[] = ['public'], job = 'agent_reasoning'): Promise<void> {
  const { a, w, hubId, connectionId } = x;
  const route = await a.cmd(w.people.owner, (trx, ctx) => modelRoutes.draft(trx, ctx, hubId, {
    job, scope: { kind: 'extension', extensionId }, primary: { connectionId, modelId: 'synthetic-model', modelRevision: 'synthetic-rev-1' }, fallbacks: [], allowedDataClasses: classes,
    limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxFileBytes: null, timeoutMs: 500 }, budgetId: null,
  } as Parameters<typeof modelRoutes.draft>[3]));
  const isPrivate = classes.some((c) => c !== 'public');
  let approval: string | null = null;
  if (isPrivate) {
    const digest = (await x.admin.query<{ d: string }>('SELECT trustwork.providers_route_digest($1) AS d', [route.id])).rows[0]!.d;
    const request = await a.cmd(w.people.officer, (trx, ctx) => approvals.request(trx, ctx, { action: 'models.activate_private_route', scope: { kind: 'hub', hubId }, actionDigest: digest }));
    await a.cmd(w.people.owner, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    approval = request.id;
  }
  await a.cmd(isPrivate ? w.people.officer : w.people.owner, (trx, ctx) => modelRoutes.activate(trx, ctx, route.id, route.revision, approval));
}

/** The egress cell of a private class, allowed by a second person. */
export async function allowEgress(x: ExtensionWorld, dataClass: string): Promise<void> {
  const { a, w, hubId, connectionId } = x;
  const version = await a.as(w.people.owner, (trx) => egressRules.nextVersion(trx, connectionId, dataClass));
  const digest = computeDigest(egressAllowDigestInput({ hubId, connectionId, dataClass, requireInResidency: true, requireZeroRetention: true, version })).value;
  const request = await a.cmd(w.people.owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'egress.allow_private_class', scope: { kind: 'hub', hubId }, actionDigest: digest }));
  await a.cmd(w.people.officer, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
  await a.cmd(w.people.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId, dataClass, decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: request.id }));
}

export const draftVersion = async (x: ExtensionWorld, manifest: AgentExtensionManifest, by: Client = x.staff.owner) => ok<CommandBody & VersionBody>(await command(by, `${x.base}/versions`, { manifest }), 201).version;
/** Draft, suite on the fake adapter under the worker role: the version comes back tested. */
export async function testedVersion(x: ExtensionWorld, manifest: AgentExtensionManifest, by: Client = x.staff.owner): Promise<VersionBody['version']> {
  const drafted = await draftVersion(x, manifest, by);
  ok(await command(by, `${x.base}/versions/${drafted.ref.id}/safety-runs`, { expectedRevision: drafted.revision }), 201);
  await x.drain();
  return viewOf(x, drafted.ref.id);
}
export const viewOf = async (x: ExtensionWorld, versionId: string): Promise<VersionBody['version']> => ok<VersionBody>(await x.staff.owner.get(`${x.base}/versions/${versionId}`)).version;

/** The reviewer proposes, the drafter asks and applies, the reviewer approves: two people, neither alone. */
export async function activateVersion(x: ExtensionWorld, versionIds: string[], proposer: Client = x.staff.officer, requester: Client = x.staff.owner, approver: Client = x.staff.officer): Promise<Response> {
  const proposed = ok<ActivationBody>(await command(proposer, `${x.base}/activations`, { versionIds }), 201).activation;
  const url = `${x.base}/activations/${proposed.configVersionId}/activate`;
  const pending = ok<CommandBody>(await command(requester, url, { expectedRevision: proposed.revision, approvalId: null }));
  assert.equal(pending.result.outcome, 'pending_second_person');
  const approvalId = pending.result.approvalRequestId as string;
  ok(await command(approver, `/v1/admin/approvals/${approvalId}/approve`, { actionDigest: proposed.activation.actionDigest }));
  return command(requester, url, { expectedRevision: proposed.revision, approvalId });
}

export const uniqueKey = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
export { HUB_CONSOLE_CONTRACT_VERSION };
