import { approvals } from '../../packages/data/src/repositories/admin.js';
import { egressAllowDigestInput } from '../../packages/contracts/src/providers.js';
import { randomUUID } from 'node:crypto';
import { computeDigest, MandateV2Schema } from '@trustwork/contracts';
import { createPool, withMaintenance } from '@trustwork/data';
import { sql } from 'kysely';
import { AgentModuleManifestSchema } from '../../packages/contracts/src/agent-catalog.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import { SYNTHETIC_ORDER_MANIFEST } from '../assistant/manifest-fixture.js';
import { budgets } from '../../packages/data/src/repositories/billing.js';
import { mandates, runs } from '../../packages/data/src/repositories/assistant.js';
import { egressRules, modelRoutes, providerConnections } from '../../packages/data/src/repositories/providers.js';
import type { ModelCall, ModelRuntimeBinding } from '../../packages/contracts/src/models.js';
import { provisionTestDatabase } from '../data/helpers/postgres.js';
import { actors, activateResidency, buildProvidersWorld, SELF_US, setUpHubs, syncKernel } from '../providers/helpers.js';
import { request, SyntheticAuthority } from './fixtures.js';
import type { ModelGovernancePort } from '../../apps/api/src/modules/models/runtime-authority.js';

/** Only missing governance scopes are synthetic; session, run, mandates, BILL and KEYS use their real commands. */
export const syntheticGovernance: ModelGovernancePort = {
  async check(call) {
    const answer = new SyntheticAuthority().answer;
    return { ...answer, principalId: call.principalId, mandateId: call.mandateId, mandateRevision: call.mandateRevision, runId: call.runId };
  },
};
export async function durableWorld(db: NonNullable<Awaited<ReturnType<typeof provisionTestDatabase>>>) {
  await db.migrate();
  await db.createAppLogin();
  const pool = createPool({ ...db.appConfig, max: 5 });
  try {
    await syncKernel(db.admin);
    const world = await buildProvidersWorld(db.admin);
    const a = actors(db.admin, pool, world);
    const personId = world.people.owner;
    const { hubA: hubId } = await setUpHubs(a, world, 'synthetic-durable-model');
    const serving = (await db.admin.query<{ id: string }>(
      'INSERT INTO trustwork.agent_serving_hub(origin,hub_id) VALUES ($1,$2) RETURNING id', ['https://trustwork.test', hubId],
    )).rows[0]!;
    // An exact test-only engine capability, never a permissive production extension resolver.
    const manifest = AgentModuleManifestSchema.parse({
      ...SYNTHETIC_ORDER_MANIFEST, key: 'research', actions: ['research'],
      capabilities: [{ ...SYNTHETIC_ORDER_MANIFEST.capabilities[0], id: 'research.draft', kind: 'draft',
        source: { kind: 'module', moduleKey: 'research', moduleVersion: '1.0.0' },
        mandateAction: 'research', contextKinds: ['profile', 'project'], confirmation: 'none', budgetKind: null, sideEffects: ['draft_state', 'external_call'] }],
    });
    const control = engineDefaultPolicy(hubId, { manifests: [manifest], extensions: [] }).modules[0];
    await withMaintenance(db.admin, trx => sql`INSERT INTO trustwork.agent_engine_manifest(module_key,module_version,document,default_control)
      VALUES('research','1.0.0',${JSON.stringify(manifest)}::jsonb,${JSON.stringify(control)}::jsonb)`.execute(trx));
    await activateResidency(a, personId, world.people.officer, hubId, ['US']);
    const createConnection = async () => {
      const connection = await a.cmd(personId, (trx, ctx) =>
        providerConnections.create(trx, ctx, hubId, {
          adapterId: 'fake',
          mode: 'fake',
          label: 'Synthetic durable model',
          capabilities: ['llm'],
          endpoint: null,
          hosting: SELF_US,
          storageCountry: null,
          region: null,
          credentialRefId: null,
        }),
      );
      const material = await a.cmd(personId, (trx, ctx) => providerConnections.testMaterial(trx, ctx, connection.id));
      await a.cmd(personId, (trx, ctx) =>
        providerConnections.recordTest(trx, ctx, connection.id, {
          configDigest: material.config_digest,
          outcome: 'ok',
          latencyMs: 1,
          modelsListed: 1,
          cost: null,
          probeDigest: 'a'.repeat(64),
          secretRefId: null,
        }),
      );
      await a.cmd(personId, async (trx, ctx) =>
        providerConnections.enable(trx, ctx, connection.id, (await providerConnections.get(trx, connection.id))!.revision, null),
      );
      return connection;
    };
    const connection = await createConnection();
    const secondary = await createConnection();
    const route = await a.cmd(personId, (trx, ctx) =>
      modelRoutes.draft(trx, ctx, hubId, {
        job: 'agent_drafting',
        scope: { kind: 'job' },
        primary: { connectionId: connection.id, modelId: 'synthetic-model', modelRevision: 'synthetic-rev-1' },
        fallbacks: [{ connectionId: secondary.id, modelId: 'synthetic-model', modelRevision: 'synthetic-rev-2' }],
        allowedDataClasses: ['public', 'person_private'],
        limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxFileBytes: null, timeoutMs: 500 },
        budgetId: null,
      }),
    );
    const routeDigest = (await db.admin.query<{ d: string }>('SELECT trustwork.providers_route_digest($1) AS d', [route.id])).rows[0]!.d;
    const approval = await a.cmd(world.people.officer, (trx, ctx) =>
      approvals.request(trx, ctx, { action: 'models.activate_private_route', scope: { kind: 'hub', hubId }, actionDigest: routeDigest }),
    );
    await a.cmd(personId, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', routeDigest));
    await a.cmd(world.people.officer, (trx, ctx) => modelRoutes.activate(trx, ctx, route.id, route.revision, approval.id));
    const allowPrivate = async () => {
      for (const connectionId of [connection.id, secondary.id]) {
        const version = await a.as(personId, (trx) => egressRules.nextVersion(trx, connectionId, 'person_private'));
        const digest = computeDigest(
          egressAllowDigestInput({ hubId, connectionId, dataClass: 'person_private', requireInResidency: true, requireZeroRetention: true, version }),
        ).value;
        const approval = await a.cmd(personId, (trx, ctx) =>
          approvals.request(trx, ctx, { action: 'egress.allow_private_class', scope: { kind: 'hub', hubId }, actionDigest: digest }),
        );
        await a.cmd(world.people.officer, (trx, ctx) => approvals.decide(trx, ctx, approval.id, 'approve', digest));
        await a.cmd(personId, (trx, ctx) =>
          egressRules.set(trx, ctx, {
            connectionId,
            dataClass: 'person_private',
            decision: 'allow',
            requireInResidency: true,
            requireZeroRetention: true,
            approvalId: approval.id,
          }),
        );
      }
    };
    const egress = (decision: 'allow' | 'deny') =>
      a.cmd(personId, (trx, ctx) =>
        egressRules.set(trx, ctx, {
          connectionId: connection.id,
          dataClass: 'public',
          decision,
          requireInResidency: true,
          requireZeroRetention: true,
          approvalId: null,
        }),
      );
    await egress('allow');
    await a.cmd(personId, (trx, ctx) =>
      egressRules.set(trx, ctx, {
        connectionId: secondary.id,
        dataClass: 'public',
        decision: 'allow',
        requireInResidency: true,
        requireZeroRetention: true,
        approvalId: null,
      }),
    );
    const principal = { personId, authzEpoch: 1 };
    const binding: ModelRuntimeBinding = { sessionId: world.sessions.owner, authzEpoch: 1, action: 'research', context: { kind: 'profile', id: personId } };
    const budget = (limit = '100') =>
      a.as(personId, (trx) =>
        budgets.grant(trx, {
          kind: 'platform',
          owner: 'person',
          projectId: null,
          employeePersonId: null,
          periodFrom: new Date(Date.now() - 60000),
          periodTo: new Date(Date.now() + 86400000),
          limitMinor: limit,
          currency: 'USD',
        }),
      );
    const mandate = async (budgetId: string, cap = '100', perAction = cap) => {
      const snapshot = MandateV2Schema.parse({
        id: randomUUID(),
        schemaVersion: 2,
        principal: { personId, onBehalfOf: null },
        grantee: { kind: 'own_agent' },
        moduleKeys: ['research'],
        actions: ['research'],
        contexts: [{ kind: 'profile', id: personId }],
        limits: {
          ceiling: { minorUnits: cap, currency: 'USD' },
          perActionCeiling: { minorUnits: perAction, currency: 'USD' },
          transactionBudgetId: null,
          platformBudgetId: budgetId,
          perWindow: null,
        },
        conditions: [],
        approvalPolicy: { mode: 'pre_authorized' },
        approvers: [],
        escalation: { kind: 'ask_principal' },
        confirmation: { via: 'first_party_form', personId, at: new Date().toISOString(), stepUp: true },
        validUntil: new Date(Date.now() + 86400000).toISOString(),
        status: 'active',
        revision: 1,
        revokedAt: null,
      });
      return a.as(personId, (trx) =>
        mandates.confirm(trx, {
          snapshot,
          contexts: snapshot.contexts,
          digest: computeDigest(snapshot).value,
          expectedRevision: null,
          stepUp: true,
          proposalId: null,
        }),
      );
    };
    const call = async (mandateId: string, amount = '7'): Promise<ModelCall> => {
      const run = await a.as(personId, async trx => {
        const created = await runs.start(trx, { principal_person_id: personId, mandate_id: mandateId, kind: 'conversation' });
        await sql`SELECT trustwork.agent_modules_bind_run(${created.id}::uuid,${serving.id}::uuid,${binding.sessionId}::uuid)`.execute(trx);
        return created;
      });
      return {
        ...request,
        operationId: randomUUID(),
        principalId: personId,
        runId: run.id,
        mandateId,
        hubId,
        allowedConnections: [connection.id, secondary.id],
        dataClasses: ['public'],
        estimatedCost: { minorUnits: amount, currency: 'USD' },
      };
    };
    return { pool, world, a, personId, principal, binding, budget, mandate, call, connection, secondary, hubId, egress, allowPrivate };
  } catch (error) {
    await pool.end();
    await db.close();
    throw error;
  }
}
