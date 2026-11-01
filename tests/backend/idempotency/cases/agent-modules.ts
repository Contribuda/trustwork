import assert from 'node:assert/strict';
import { sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { approvals, staffAssignments, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { runtimeHubPolicy } from '../../../agent-modules/fixtures.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;
/** Test role definitions over the console vocabulary (version 11, unused elsewhere), held at the node. */
const PERMISSIONS = ['admin.hub.read', 'admin.config.edit', 'admin.agents.read', 'admin.agents.policy.edit', 'admin.agents.modules.activate', 'admin.agents.kill'];
const VERSION = 11;
const PASSWORD = 'fixture-password-agt3-crash-01';

async function ctxOf(h: Harness, personId: string): Promise<CommandContext> {
  const session = await withMaintenance(h.db.admin, (trx) => trx.insertInto('session').values({ person_id: personId, token_hash: randomBytes(32), idle_expires_at: new Date(Date.now() + 3_600_000), absolute_expires_at: new Date(Date.now() + 3_600_000), auth_method: 'password' }).returning('id').executeTakeFirstOrThrow());
  const elevation = await withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => sessionElevations.insert(trx, { sessionId: session.id, personId, factorKind: 'totp', createdAt: new Date(), expiresAt: new Date(Date.now() + 900_000) }));
  return { elevationId: elevation.id, requestId: `req-${randomUUID()}`, reasonCode: 'synthetic_test', reasonText: 'Synthetic crash test setup' };
}
const as = async <T>(h: Harness, personId: string, fn: (trx: Transaction, ctx: CommandContext) => Promise<T>): Promise<T> => {
  const ctx = await ctxOf(h, personId);
  return withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => fn(trx, ctx));
};

/**
 * AGT-003: drafting and activating the hub agent policy, engaging and releasing an agent kill switch, turning a job on and
 * running it now, each crashed before and after the commit. Two synthetic staff people (operations engineer and
 * trust reviewer at the node, assigned by the founding platform owner of the ADM-001 case) manage a synthetic hub's
 * agent policy; a synthetic participant turns a job on. Every person and hub is synthetic.
 */
export default {
  name: 'AGT-003: hub agent policy, agent kill switches and jobs',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founder = (await admin.query<{ person_id: string; node: string }>("SELECT a.person_id, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.revoked_at IS NULL AND a.role = 'platform-owner'")).rows[0];
    assert.ok(founder, 'the ADM-001 case set up the founding administrators');
    const passwordHash = await hash(PASSWORD, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const ids = await withMaintenance(admin, async (trx) => {
      for (const role of ['ops-engineer', 'trust-reviewer'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['node'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute();
      }
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      const participant = await person('Synthetic Agent Modules Participant');
      await trx.insertInto('email_binding').values({ person_id: participant, email_normalized: 'crash-agt3-participant@example.invalid', is_primary: true, verified_at: new Date('2026-10-01T09:00:00Z') }).execute();
      await trx.insertInto('credential').values({ person_id: participant, kind: 'password', password_hash: passwordHash }).execute();
      const binding = await trx.selectFrom('agent_serving_hub').select('hub_id').where('origin', '=', h.created.config.publicOrigin).executeTakeFirst();
      const hub = binding ? { id: binding.hub_id } : await trx.insertInto('hub').values({ slug: `synthetic-agt3-${randomBytes(3).toString('hex')}`, lifecycle: 'draft' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: hub.id, node_id: founder.node, name: { en: 'Synthetic agent modules hub' }, default_locale: 'en', locales: ['en'], time_zone: 'America/New_York', currency: 'USD', created_by: founder.person_id }).execute();
      if (!binding) await sql`INSERT INTO trustwork.agent_serving_hub (origin, hub_id) VALUES (${h.created.config.publicOrigin}, ${hub.id}::uuid)`.execute(trx);
      return { drafter: await person('Synthetic Agent Policy Drafter'), activator: await person('Synthetic Agent Policy Activator'), participant, hubId: hub.id };
    });
    for (const [personId, role] of [[ids.drafter, 'ops-engineer'], [ids.activator, 'trust-reviewer']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'node', nodeId: founder.node }, definitionVersion: VERSION }));
      h.staff.set(personId, [role]);
    }
    await addLogins(h, [[ids.drafter, 'crash-agt3-drafter@example.invalid'], [ids.activator, 'crash-agt3-activator@example.invalid']]);
    const clients = {} as Record<'drafter' | 'activator', Client>;
    const secrets = {} as Record<'drafter' | 'activator', Buffer>;
    for (const key of ['drafter', 'activator'] as const) {
      clients[key] = h.client();
      await signIn(clients[key], `crash-agt3-${key}@example.invalid`);
      secrets[key] = await enrolNow(h, clients[key]);
    }
    h.clock.advance(30_000);
    for (const key of ['drafter', 'activator'] as const) {
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
    }
    const previousHub = process.env.TRUSTWORK_HUB_ID;
    process.env.TRUSTWORK_HUB_ID = ids.hubId;
    try {
      const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
      const base = `/v1/admin/agent-modules/${ids.hubId}`;
      const body = <T>(r: { body: unknown }) => r.body as T;

      // Policy: draft (validated, preview stored), then activation without an approval asks a second person.
      const drafted = body<{ version: { versionId: string; revision: number; activation: { actionDigest: string } } }>(await exactlyOnce({
        action: 'agent_modules.policy_draft', client: clients.drafter, url: `${base}/policy`, body: cmd('agent_modules.policy_draft', { document: runtimeHubPolicy(ids.hubId) }),
        effects: () => count(h, 'SELECT 1 FROM trustwork.agent_policy_version WHERE hub_id = $1', [ids.hubId]),
      }));
      const v = drafted.version;
      const pending = body<{ result: { approvalRequestId: string } }>(await exactlyOnce({
        action: 'agent_modules.policy_activate', client: clients.activator, url: `${base}/policy/${v.versionId}/activate`, body: cmd('agent_modules.policy_activate', { expectedRevision: v.revision, approvalId: null }),
        effects: () => count(h, "SELECT 1 FROM trustwork.second_person_approval WHERE hub_id = $1 AND action = 'agents.enable_commitment_module'", [ids.hubId]),
      }));
      await as(h, ids.drafter, (trx, ctx) => approvals.decide(trx, ctx, pending.result.approvalRequestId, 'approve', v.activation.actionDigest));
      const applied = await clients.activator.post(`${base}/policy/${v.versionId}/activate`, { ...cmd('setup-activate', { expectedRevision: v.revision, approvalId: pending.result.approvalRequestId }), idempotencyKey: 'crash-agt3-setup-activate' }, { idempotencyKey: 'crash-agt3-setup-activate' });
      assert.equal(applied.status, 200, JSON.stringify(applied.body));

      // Kill switches: engaging is immediate; releasing without an approval asks a second person.
      const engaged = body<{ killSwitch: { id: string } }>(await exactlyOnce({
        action: 'agent_modules.kill_switch_engage', client: clients.drafter, url: `${base}/kill-switches`, body: cmd('agent_modules.kill_switch_engage', { scope: { kind: 'agent_capability', capabilityId: 'project_planner.revoke_share' } }),
        effects: () => count(h, "SELECT 1 FROM trustwork.kill_switch WHERE hub_id = $1 AND capability_id = 'project_planner.revoke_share'", [ids.hubId]),
      }));
      await exactlyOnce({
        action: 'agent_modules.kill_switch_release', client: clients.activator, url: `${base}/kill-switches/${engaged.killSwitch.id}/release`, body: cmd('agent_modules.kill_switch_release', { incidentNote: 'Synthetic incident', approvalId: null }),
        effects: () => count(h, "SELECT 1 FROM trustwork.second_person_approval WHERE hub_id = $1 AND action = 'kill_switch.release'", [ids.hubId]),
      });

      // Jobs: confirmation binds one supported template; run-now records one durable occurrence in the API operation.
      const participant = h.client();
      const login = await participant.post('/v1/auth/login', { email: 'crash-agt3-participant@example.invalid', password: PASSWORD }, { idempotencyKey: null });
      assert.equal(login.status, 200);
      const proposedGoal = await participant.post('/v1/assistant/goals', {
        onBehalfOf: null, text: 'Synthetic crash-tested report goal', successCriteria: ['One private local report'], needs: [], budgetRange: null,
        horizon: new Date(Date.now() + 30 * 86_400_000).toISOString(), reportCadence: 'none',
      });
      assert.equal(proposedGoal.status, 201, JSON.stringify(proposedGoal.body));
      const goal = body<{ goal: { id: string }; confirmation: { digest: unknown } }>(proposedGoal);
      assert.equal((await participant.post(`/v1/assistant/goals/${goal.goal.id}/confirm`, { digest: goal.confirmation.digest })).status, 200);
      const turned = body<{ request: { id: string }; confirmation: { proposalId: string; digest: unknown } }>(await exactlyOnce({
        action: 'agent_modules.job_turn_on', client: participant, url: '/v1/assistant/jobs',
        body: { actingFor: 'self', moduleKey: 'core', templateKey: 'goal_progress_report', trigger: { kind: 'request' }, goalContextIds: [goal.goal.id], validUntil: new Date(Date.now() + 90 * 86_400_000).toISOString() },
        effects: () => count(h, 'SELECT 1 FROM trustwork.agent_job_request WHERE principal_person_id = $1', [ids.participant]),
      }));
      const fresh = h.client();
      assert.equal((await fresh.post('/v1/auth/login', { email: 'crash-agt3-participant@example.invalid', password: PASSWORD }, { idempotencyKey: null })).status, 200);
      const confirmed = await fresh.post(`/v1/assistant/mandate-proposals/${turned.confirmation.proposalId}/confirm`, { digest: turned.confirmation.digest }, { idempotencyKey: 'crash-agt3-setup-confirm' });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      await exactlyOnce({
        action: 'agent_modules.job_run_now', client: participant, url: `/v1/assistant/jobs/${turned.request.id}/run`, body: {},
        effects: () => count(h, "SELECT 1 FROM trustwork.agent_job_occurrence WHERE principal_person_id = $1 AND source_kind = 'request'", [ids.participant]),
      });
    } finally {
      if (previousHub === undefined) delete process.env.TRUSTWORK_HUB_ID;
      else process.env.TRUSTWORK_HUB_ID = previousHub;
    }
  },
} satisfies CrashCase;
