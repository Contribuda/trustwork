import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import { staffAssignments, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { egressRules, modelRoutes, providerConnections } from '../../../../packages/data/src/repositories/providers.js';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { manifestOf } from '../../../agent-extensions/manifests.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
/** Test role definitions over the console vocabulary (version 41, unused elsewhere), held at the node. */
const PERMISSIONS = [
  'admin.hub.read', 'admin.config.edit', 'admin.agents.read', 'admin.agents.extensions.edit', 'admin.agents.extensions.activate', 'admin.agents.extensions.suspend', 'admin.providers.read',
  'admin.providers.connection.edit', 'admin.providers.test', 'admin.providers.toggle', 'admin.providers.egress.edit', 'admin.models.route.edit', 'admin.models.route.activate',
];
const VERSION = 41;

async function ctxOf(h: Harness, personId: string): Promise<CommandContext> {
  const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: personId, token_hash: randomBytes(32), auth_method: 'password', idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000) }).returning('id').executeTakeFirstOrThrow());
  const elevation = await withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) }));
  return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic crash test setup' };
}
const as = async <T>(h: Harness, personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
  const ctx = await ctxOf(h, personId);
  return withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => fn(trx, ctx));
};

/**
 * AGT-023: drafting a version, asking for a safety run, proposing an activation, asking for and applying activation,
 * suspending and retiring, each crashed before and after the commit. Two synthetic staff people manage a synthetic hub of
 * their own. The worker's result is written by the maintenance path here: the runs themselves are tested in
 * tests/agent-extensions under the worker role.
 */
export default {
  name: 'AGT-023: governed extension registry',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founder = (await admin.query<{ person_id: string; node: string }>("SELECT a.person_id, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.role = 'platform-owner' LIMIT 1")).rows[0];
    assert.ok(founder, 'the ADM-001 case set up the founding administrators');
    const ids = await withMaintenance(admin, async (trx) => {
      for (const role of ['ops-engineer', 'trust-reviewer'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['node'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute();
      }
      const person = async (name: string, email: string) => {
        const id = (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
        return { id, email };
      };
      const hub = await trx.insertInto('hub').values({ slug: `synthetic-agt23-${randomBytes(3).toString('hex')}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: founder.node, name: { en: 'Synthetic extension hub' }, default_locale: 'en', locales: ['en'], time_zone: 'America/New_York', currency: 'USD', created_by: founder.person_id }).execute();
      return { drafter: await person('Synthetic Extension Drafter', 'crash-agt23-drafter@example.invalid'), reviewer: await person('Synthetic Extension Reviewer', 'crash-agt23-reviewer@example.invalid'), hubId: hub.id };
    });
    const { hubId } = ids;
    for (const [person, role] of [[ids.drafter, 'ops-engineer'], [ids.reviewer, 'trust-reviewer']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId: person.id, role, scope: { kind: 'node', nodeId: founder.node }, definitionVersion: VERSION }));
      h.staff.set(person.id, [role]);
    }
    await addLogins(h, [[ids.drafter.id, ids.drafter.email], [ids.reviewer.id, ids.reviewer.email]]);
    const clients = {} as Record<'drafter' | 'reviewer', Client>;
    const secrets = {} as Record<'drafter' | 'reviewer', Buffer>;
    for (const key of ['drafter', 'reviewer'] as const) {
      clients[key] = h.client();
      await signIn(clients[key], ids[key].email);
      secrets[key] = await enrolNow(h, clients[key]);
    }
    h.clock.advance(30_000);
    for (const key of ['drafter', 'reviewer'] as const) {
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
    }
    const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const base = `/v1/admin/agent-extensions/${hubId}`;
    const body = <T>(r: { body: unknown }) => r.body as T;
    type Version = { version: { ref: { id: string; extensionId: string }; revision: number } };

    const drafted = body<Version>(await exactlyOnce({
      action: 'agent_extensions.version_draft', client: clients.drafter, url: `${base}/versions`, body: cmd('agent_extensions.version_draft', { manifest: manifestOf('crash_lookup') }),
      effects: () => count(h, 'SELECT 1 FROM trustwork.agent_extension_version WHERE hub_id = $1', [hubId]),
    })).version;
    const run = body<{ run: { id: string } }>(await exactlyOnce({
      action: 'agent_extensions.safety_run_request', client: clients.drafter, url: `${base}/versions/${drafted.ref.id}/safety-runs`, body: cmd('agent_extensions.safety_run_request', { expectedRevision: drafted.revision }),
      effects: () => count(h, 'SELECT 1 FROM trustwork.agent_extension_safety_run WHERE hub_id = $1', [hubId]),
    })).run;

    // What the worker would record, and the extension's own route, so the activation can be proposed.
    await withMaintenance(admin, async (trx) => {
      await sql`INSERT INTO trustwork.agent_extension_engine (id, engine_version) VALUES (true, '0.1.0') ON CONFLICT (id) DO UPDATE SET engine_version = EXCLUDED.engine_version`.execute(trx);
      await trx.updateTable('agent_extension_safety_run').set({ state: 'passed', engine_version: '0.1.0', report: JSON.stringify({ synthetic: true }), report_digest: 'a'.repeat(64), scenario_count: 1, completed_at: new Date() }).where('id', '=', run.id).execute();
      await trx.updateTable('agent_extension_version').set({ status: 'tested', passing_run_id: run.id }).where('id', '=', drafted.ref.id).execute();
    });
    const connection = await as(h, ids.drafter.id, (trx, ctx) => providerConnections.create(trx, ctx, hubId, {
      adapterId: 'fake', mode: 'fake', label: 'Synthetic extension connection', capabilities: ['llm'], endpoint: null, hosting: { kind: 'self_hosted', country: 'US' }, storageCountry: null, region: null, credentialRefId: null,
    }));
    const material = await as(h, ids.drafter.id, (trx, ctx) => providerConnections.testMaterial(trx, ctx, connection.id));
    await as(h, ids.drafter.id, (trx, ctx) => providerConnections.recordTest(trx, ctx, connection.id, { configDigest: material.config_digest, outcome: 'ok', latencyMs: 1, modelsListed: 1, cost: null, probeDigest: 'a'.repeat(64), secretRefId: null }));
    await as(h, ids.drafter.id, async (trx, ctx) => providerConnections.enable(trx, ctx, connection.id, (await providerConnections.get(trx, connection.id))!.revision, null));
    await as(h, ids.drafter.id, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: connection.id, dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null }));
    const route = await as(h, ids.drafter.id, (trx, ctx) => modelRoutes.draft(trx, ctx, hubId, {
      job: 'agent_reasoning', scope: { kind: 'extension', extensionId: drafted.ref.extensionId }, primary: { connectionId: connection.id, modelId: 'synthetic-model', modelRevision: 'synthetic-rev-1' }, fallbacks: [],
      allowedDataClasses: ['public'], limits: { maxInputTokens: 1000, maxOutputTokens: 100, maxFileBytes: null, timeoutMs: 500 }, budgetId: null,
    }));
    await as(h, ids.drafter.id, (trx, ctx) => modelRoutes.activate(trx, ctx, route.id, route.revision, null));

    const proposed = body<{ activation: { configVersionId: string; revision: number } }>(await exactlyOnce({
      action: 'agent_extensions.activation_draft', client: clients.reviewer, url: `${base}/activations`, body: cmd('agent_extensions.activation_draft', { versionIds: [drafted.ref.id] }),
      effects: () => count(h, "SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1 AND domain = 'agent_extensions'", [hubId]),
    })).activation;
    await exactlyOnce({
      action: 'agent_extensions.activation_activate', client: clients.drafter, url: `${base}/activations/${proposed.configVersionId}/activate`,
      body: cmd('agent_extensions.activation_activate', { expectedRevision: proposed.revision, approvalId: null }),
      effects: () => count(h, "SELECT 1 FROM trustwork.second_person_approval WHERE hub_id = $1 AND action = 'agents.activate_extension'", [hubId]),
    });

    const current = (await admin.query<{ revision: number }>('SELECT revision FROM trustwork.agent_extension_version WHERE id = $1', [drafted.ref.id])).rows[0]!;
    await exactlyOnce({
      action: 'agent_extensions.version_suspend', client: clients.drafter, url: `${base}/versions/${drafted.ref.id}/suspend`, body: cmd('agent_extensions.version_suspend', { expectedRevision: current.revision }),
      effects: () => count(h, "SELECT 1 FROM trustwork.agent_extension_transition WHERE hub_id = $1 AND to_status = 'suspended'", [hubId]),
    });
    const suspended = (await admin.query<{ revision: number }>('SELECT revision FROM trustwork.agent_extension_version WHERE id = $1', [drafted.ref.id])).rows[0]!;
    await exactlyOnce({
      action: 'agent_extensions.version_retire', client: clients.drafter, url: `${base}/versions/${drafted.ref.id}/retire`, body: cmd('agent_extensions.version_retire', { expectedRevision: suspended.revision }),
      effects: () => count(h, "SELECT 1 FROM trustwork.agent_extension_transition WHERE hub_id = $1 AND to_status = 'retired'", [hubId]),
    });
  },
} satisfies CrashCase;
