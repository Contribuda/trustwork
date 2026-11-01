import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal, type Transaction } from '@trustwork/data';
import { computeDigest, HUB_CONSOLE_CONTRACT_VERSION } from '@trustwork/contracts';
import type { Client, Harness } from '../../helpers/app.js';
import { codeNow } from '../../second-factor/helpers.js';
import { addLogins, enrolNow, signIn } from '../../../admin/helpers.js';
import { principalFor } from '../../../data/helpers/seed.js';
import { approvals, staffAssignments, type CommandContext } from '../../../../packages/data/src/repositories/admin.js';
import { sessionElevations } from '../../../../packages/data/src/repositories/identity.js';
import { hubs } from '../../../../packages/data/src/repositories/hubs.js';
import { providerKillReleaseDigestInput } from '../../../../packages/contracts/src/providers.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/** Test role definitions over the console vocabulary (version 12, unused elsewhere), held at the node so they cover every hub. */
const PERMISSIONS = [
  'admin.node.hubs.manage', 'admin.hub.read', 'admin.providers.read', 'admin.providers.connection.edit', 'admin.providers.secret.write', 'admin.providers.test',
  'admin.providers.toggle', 'admin.providers.egress.edit', 'admin.providers.budget.edit', 'admin.providers.kill', 'admin.models.route.edit', 'admin.models.route.activate',
];
const VERSION = 12;

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
 * KEYS-001: every providers route that completes in its transaction, crashed before and after the commit. Two synthetic
 * staff people (operations engineer and data steward at the node, assigned by the founding platform owner of the
 * ADM-001 case) run each command once on a synthetic hub with fake connections only. The write-only secret route is
 * not idempotent and is not listed. Every person and hub is synthetic.
 */
export default {
  name: 'KEYS-001: provider connections, egress, routes, caps, cost records and kill switches',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founder = (await admin.query<{ person_id: string; node: string }>("SELECT a.person_id, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.revoked_at IS NULL AND a.role = 'platform-owner'")).rows[0];
    assert.ok(founder, 'the ADM-001 case set up the founding administrators');
    const nodeId = founder.node;
    const people = await withMaintenance(admin, async (trx) => {
      for (const role of ['ops-engineer', 'data-steward'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['node'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute();
      }
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      return { ops: await person('Synthetic Providers Ops Engineer'), steward: await person('Synthetic Providers Data Steward') };
    });
    for (const [personId, role] of [[people.ops, 'ops-engineer'], [people.steward, 'data-steward']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'node', nodeId }, definitionVersion: VERSION }));
      h.staff.set(personId, [role]);
    }
    const hubId = (await as(h, people.ops, (trx, ctx) => hubs.create(trx, ctx, { slug: 'synthetic-crash-providers', name: { en: 'Synthetic crash providers hub' }, defaultLocale: 'en', locales: ['en'],
      timeZone: 'America/Los_Angeles', currency: 'USD', countryPack: null, territories: [{ level: 'place', code: 'US-CA:san-diego' }] }))).hub_id;
    await addLogins(h, [[people.ops, 'crash-providers-ops@example.invalid'], [people.steward, 'crash-providers-steward@example.invalid']]);
    const clients = {} as Record<'ops' | 'steward', Client>;
    for (const key of ['ops', 'steward'] as const) {
      clients[key] = h.client();
      await signIn(clients[key], `crash-providers-${key}@example.invalid`);
      const secret = await enrolNow(h, clients[key]);
      h.clock.advance(30_000);
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secret) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
    }
    const base = `/v1/admin/hubs/${hubId}/providers`;
    const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const body = <T>(r: { body: unknown }) => r.body as T;
    const changes = (action: string) => () => count(h, 'SELECT 1 FROM trustwork.provider_config_change WHERE hub_id = $1 AND action = $2', [hubId, action]);

    // Connections (fake mode: no secret, no network).
    const created = body<{ connection: { id: string; revision: number } }>(await run('providers.connection_create', clients.ops, `${base}/connections`, {
      adapterId: 'fake', mode: 'fake', label: 'Synthetic crash fake', capabilities: ['llm'], endpoint: null, hosting: { kind: 'self_hosted', country: 'US' }, storageCountry: null, region: null, credentialRefId: null,
    }, () => count(h, 'SELECT 1 FROM trustwork.provider_connection WHERE hub_id = $1', [hubId])));
    const connectionId = created.connection.id;
    const updated = body<{ connection: { revision: number } }>(await run('providers.connection_update', clients.ops, `${base}/connections/${connectionId}/update`, {
      expectedRevision: created.connection.revision, label: 'Synthetic crash fake (renamed)', capabilities: ['llm'], endpoint: null, hosting: { kind: 'self_hosted', country: 'US' }, storageCountry: null, region: null, credentialRefId: null,
    }, changes('providers.connection_updated')));
    const tested = body<{ connection: { revision: number } }>(await run('providers.connection_test', clients.ops, `${base}/connections/${connectionId}/test`, { connectionId, syntheticInputOnly: true },
      () => count(h, 'SELECT 1 FROM trustwork.connection_test WHERE connection_id = $1', [connectionId])));
    void updated;
    const enabled = body<{ connection: { revision: number } }>(await run('providers.connection_enable', clients.ops, `${base}/connections/${connectionId}/enable`, { expectedRevision: tested.connection.revision, approvalId: null },
      changes('providers.connection_enabled')));

    // Egress, routes and caps.
    await run('providers.egress_set', clients.ops, `${base}/egress`, { connectionId, dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null },
      () => count(h, 'SELECT 1 FROM trustwork.egress_rule WHERE connection_id = $1', [connectionId]));
    const cap = body<{ cap: { budget: { id: string; revision: number } } }>(await run('providers.cap_create', clients.ops, `${base}/caps`, {
      scope: { kind: 'job', job: 'summarisation' }, period: 'month', limit: { minorUnits: '1000', currency: 'USD' }, alertAtPercent: [80], onExhausted: 'deny_new',
    }, () => count(h, 'SELECT 1 FROM trustwork.provider_budget WHERE hub_id = $1', [hubId])));
    const capUpdated = body<{ cap: { budget: { revision: number } } }>(await run('providers.cap_update', clients.ops, `${base}/caps/${cap.cap.budget.id}/update`, {
      expectedRevision: cap.cap.budget.revision, limit: { minorUnits: '2000', currency: 'USD' }, alertAtPercent: [50, 80], onExhausted: 'pause',
    }, changes('providers.cap_updated')));
    await run('providers.cap_retire', clients.ops, `${base}/caps/${cap.cap.budget.id}/retire`, { expectedRevision: capUpdated.cap.budget.revision }, changes('providers.cap_retired'));
    const routeBody = { job: 'summarisation', scope: { kind: 'job' }, primary: { connectionId, modelId: 'fake-model', modelRevision: 'fake-rev-1' }, fallbacks: [], allowedDataClasses: ['public'],
      limits: { maxInputTokens: 4000, maxOutputTokens: 500, maxFileBytes: null, timeoutMs: 10_000 }, budgetId: null };
    const route = body<{ route: { id: string; revision: number } }>(await run('providers.route_draft', clients.ops, `${base}/routes`, routeBody,
      () => count(h, 'SELECT 1 FROM trustwork.model_route WHERE hub_id = $1', [hubId])));
    const active = body<{ route: { revision: number } }>(await run('providers.route_activate', clients.ops, `${base}/routes/${route.route.id}/activate`, { expectedRevision: route.route.revision, approvalId: null },
      changes('providers.route_activated')));
    await run('providers.route_disable', clients.ops, `${base}/routes/${route.route.id}/disable`, { expectedRevision: active.route.revision }, changes('providers.route_disabled'));
    await run('providers.pricing_record', clients.ops, `${base}/pricing`, {
      connectionId, modelId: 'fake-model', currency: 'USD', inputPerMillionTokens: '0', outputPerMillionTokens: null, perImage: null, perAudioMinute: null, basis: 'measured', observedAt: new Date().toISOString(), sourceNote: null,
    }, () => count(h, 'SELECT 1 FROM trustwork.model_pricing WHERE hub_id = $1', [hubId]));

    // Kill switches: engage (one person), release (a second person approved the exact release and note).
    const kill = body<{ killSwitch: { id: string } }>(await run('providers.kill_engage', clients.ops, `${base}/kill-switches`, { target: { kind: 'route', job: 'summarisation', scope: { kind: 'job' } } },
      () => count(h, 'SELECT 1 FROM trustwork.provider_route_kill_switch WHERE hub_id = $1', [hubId])));
    const note = 'Synthetic crash incident note';
    const digest = computeDigest(providerKillReleaseDigestInput({ killSwitchId: kill.killSwitch.id, incidentNote: note })).value;
    const opsCtx = await ctxOf(h, people.ops);
    const request = await withPrincipal(h.pool, await principalFor(admin, people.ops), (trx) => approvals.request(trx, opsCtx, { action: 'kill_switch.release', scope: { kind: 'hub', hubId }, actionDigest: digest }));
    await as(h, people.steward, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await run('providers.kill_release', clients.ops, `${base}/kill-switches/${kill.killSwitch.id}/release`, { approvalId: request.id, incidentNote: note },
      () => count(h, "SELECT 1 FROM trustwork.provider_route_kill_switch WHERE hub_id = $1 AND state = 'released'", [hubId]));

    // Revocation needs a non-fake connection with a secret; a manual connection without one refuses before any effect,
    // so the route is crash-tested on a sealed-secret-free path: revoking twice is refused, revoking once applies.
    const manual = body<{ connection: { id: string; revision: number } }>(await clients.ops.post(`${base}/connections`, cmd('setup-manual', {
      adapterId: 'register_manual', mode: 'manual', label: 'Synthetic manual register look-up', capabilities: ['register_lookup'], endpoint: null, hosting: { kind: 'self_hosted', country: 'US' },
      storageCountry: null, region: null, credentialRefId: null,
    }), { idempotencyKey: 'crash-setup-manual' }));
    await withMaintenance(admin, async (trx) => {
      const ref = await trx.insertInto('secret_ref').values({ connection_id: manual.connection.id, hub_id: hubId, ref: `connection:${manual.connection.id}:v1`, keyed_fingerprint: '0123456789ab', version: 1, created_by: people.ops }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('secret_version').values({ secret_ref_id: ref.id, ciphertext: randomBytes(32), iv: randomBytes(12), auth_tag: randomBytes(16), wrapped_key: randomBytes(60), kek_id: 'test:crash' }).execute();
    });
    await run('providers.secret_revoke', clients.ops, `${base}/connections/${manual.connection.id}/secret/revoke`, { expectedRevision: manual.connection.revision },
      () => count(h, "SELECT 1 FROM trustwork.secret_ref WHERE connection_id = $1 AND status = 'destroyed'", [manual.connection.id]));
    await run('providers.connection_disable', clients.ops, `${base}/connections/${connectionId}/disable`, { expectedRevision: enabled.connection.revision }, changes('providers.connection_disabled'));
  },
} satisfies CrashCase;
