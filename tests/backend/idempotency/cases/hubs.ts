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
import { legalDocuments } from '../../../../packages/data/src/repositories/hubs.js';
import { legalActivationDigestInput } from '../../../../packages/contracts/src/hub-core.js';
import type { CrashCase } from '../cases.js';

const count = async (h: Harness, query: string, params: unknown[] = []): Promise<number> => (await h.db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]?.n ?? 0;

/** Test role definitions over the console vocabulary (version 9, unused elsewhere), held at the node so they cover every hub. */
const PERMISSIONS = [
  'admin.node.hubs.manage', 'admin.hub.read', 'admin.hub.identity.edit', 'admin.hub.lifecycle.request', 'admin.hub.launch.check', 'admin.config.edit', 'admin.hub.legal.edit',
  'admin.hub.legal.activate', 'admin.providers.secret.write', 'admin.providers.toggle',
];
const VERSION = 9;

/** A command context of a person's own fresh session and elevation (setup only; the routes elevate over HTTP). */
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
 * HUB-001: every hub route that completes in its transaction, crashed before and after the commit. Two synthetic staff
 * people (data steward and editor-in-chief at the node, assigned by the founding platform owner of the ADM-001 case)
 * create a synthetic hub and run each command once; the participant route accepts an active legal text of a launched
 * synthetic hub fixture. Every person and hub is synthetic.
 */
export default {
  name: 'HUB-001: hubs, configuration, launch gates, legal documents and credential references',
  async run({ h, exactlyOnce }) {
    const admin = h.db.admin;
    const founder = (await admin.query<{ person_id: string; node: string }>("SELECT a.person_id, (SELECT id FROM trustwork.admin_node LIMIT 1) AS node FROM trustwork.staff_role_assignment a WHERE a.setup_bootstrap AND a.revoked_at IS NULL AND a.role = 'platform-owner'")).rows[0];
    assert.ok(founder, 'the ADM-001 case set up the founding administrators');
    const nodeId = founder.node;
    const people = await withMaintenance(admin, async (trx) => {
      for (const role of ['data-steward', 'editor-in-chief'] as const) {
        await trx.insertInto('staff_role_definition_version').values({ role, version: VERSION, scopes: ['node'], permissions: PERMISSIONS, grant_max_hours: 72, sod_mode: 'reduced' }).onConflict((oc) => oc.doNothing()).execute();
      }
      const person = async (name: string) => (await trx.insertInto('person').values({ display_name: name }).returning('id').executeTakeFirstOrThrow()).id;
      return { steward: await person('Synthetic Hub Data Steward'), chief: await person('Synthetic Hub Editor-in-chief'), participant: await person('Synthetic Hub Participant') };
    });
    for (const [personId, role] of [[people.steward, 'data-steward'], [people.chief, 'editor-in-chief']] as const) {
      await as(h, founder.person_id, (trx, ctx) => staffAssignments.assign(trx, ctx, { personId, role, scope: { kind: 'node', nodeId }, definitionVersion: VERSION }));
      h.staff.set(personId, [role]);
    }
    await addLogins(h, [[people.steward, 'crash-hub-steward@example.invalid'], [people.chief, 'crash-hub-chief@example.invalid'], [people.participant, 'crash-hub-participant@example.invalid']]);
    const clients = {} as Record<'steward' | 'chief' | 'participant', Client>;
    const secrets = {} as Record<'steward' | 'chief', Buffer>;
    for (const key of ['steward', 'chief', 'participant'] as const) {
      clients[key] = h.client();
      await signIn(clients[key], `crash-hub-${key}@example.invalid`);
      if (key !== 'participant') secrets[key] = await enrolNow(h, clients[key]);
    }
    h.clock.advance(30_000);
    for (const key of ['steward', 'chief'] as const) {
      const r = await clients[key].post('/v1/admin/session/elevate', { proof: { method: 'totp', code: codeNow(h, secrets[key]) } }, { idempotencyKey: null });
      assert.equal(r.status, 200, `elevate ${key}: ${JSON.stringify(r.body)}`);
    }
    const cmd = (action: string, rest: Record<string, unknown> = {}) => ({ contractVersion: HUB_CONSOLE_CONTRACT_VERSION, idempotencyKey: `crash-${action}`, reason: 'Synthetic crash test', ...rest });
    const run = (action: string, client: Client, url: string, rest: Record<string, unknown>, effects: () => Promise<number>) => exactlyOnce({ action, client, url, body: cmd(action, rest), effects });
    const body = <T>(r: { body: unknown }) => r.body as T;

    // Hub, profile and territories.
    const created = body<{ result: { objectId: string }; profileRevision: number }>(await run('hub.create', clients.steward, '/v1/admin/hubs', {
      slug: 'synthetic-crash-hub', name: { en: 'Synthetic crash hub' }, defaultLocale: 'en', locales: ['en'], timeZone: 'America/Los_Angeles', currency: 'USD', countryPack: null,
      territories: [{ level: 'place', code: 'US-CA:san-diego' }],
    }, () => count(h, 'SELECT 1 FROM trustwork.hub_profile')));
    const hubId = created.result.objectId;
    const base = `/v1/admin/hubs/${hubId}`;
    await run('hub.profile_update', clients.steward, `${base}/profile`, { name: { en: 'Synthetic crash hub', es: 'Centro sintético' }, defaultLocale: 'en', locales: ['en', 'es'], timeZone: 'America/Los_Angeles', currency: 'USD', brandOverlay: null, expectedRevision: created.profileRevision },
      () => count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.profile_updated' AND object_id = $1", [hubId]));
    const territory = body<{ territory: { id: string } }>(await run('hub.territory_add', clients.steward, `${base}/territories`, { territory: { level: 'region', code: 'US-CA' } },
      () => count(h, 'SELECT 1 FROM trustwork.hub_territory WHERE hub_id = $1', [hubId])));
    await run('hub.territory_remove', clients.steward, `${base}/territories/${territory.territory.id}/remove`, {},
      () => count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.territory_removed' AND object_id = $1", [territory.territory.id]));

    // Configuration.
    await run('hub.config_import_deployment', clients.steward, `${base}/config/import-deployment`, { deployment: { schemaVersion: 1, countries: { default: 'US' }, languages: { default: 'en', enabled: ['en', 'es'] } } },
      () => count(h, "SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1 AND source = 'deployment_import' AND domain = 'identity'", [hubId]));
    const drafted = body<{ version: { id: string; revision: number } }>(await run('hub.config_draft', clients.steward, `${base}/config`, { domain: 'events', payload: { policy: 'synthetic' } },
      () => count(h, 'SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1', [hubId])));
    await run('hub.config_activate', clients.chief, `${base}/config/${drafted.version.id}/activate`, { expectedRevision: drafted.version.revision, approvalId: null },
      () => count(h, "SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1 AND status = 'active'", [hubId]));
    const another = body<{ version: { id: string } }>(await clients.steward.post(`${base}/config`, { ...cmd('setup-draft', { domain: 'learning', payload: { policy: 'synthetic' } }), idempotencyKey: 'crash-setup-draft' }, { idempotencyKey: 'crash-setup-draft' }));
    await run('hub.config_cancel', clients.steward, `${base}/config/${another.version.id}/cancel`, {},
      () => count(h, "SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1 AND status = 'cancelled'", [hubId]));

    // Launch gates and the lifecycle.
    await run('hub.gate_check', clients.steward, `${base}/launch/check`, { gate: 'i18n_complete', evidenceRef: randomUUID() },
      () => count(h, "SELECT 1 FROM trustwork.launch_gate WHERE hub_id = $1 AND state = 'passed'", [hubId]));
    await run('hub.gate_invalidate', clients.chief, `${base}/launch/invalidate`, { gate: 'i18n_complete' },
      () => count(h, "SELECT 1 FROM trustwork.launch_gate WHERE hub_id = $1 AND state = 'invalidated'", [hubId]));
    await run('hub.transition', clients.steward, `${base}/lifecycle`, { to: 'preparing', expectedRevision: 1, approvalId: null },
      () => count(h, "SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.lifecycle_changed' AND object_id = $1", [hubId]));

    // Legal documents: draft, counsel approval, activation (without an approval it asks a second person).
    const doc = body<{ document: { id: string; revision: number } }>(await run('hub.legal_draft', clients.steward, `${base}/legal`, { kind: 'terms', locale: 'en', body: 'Synthetic terms of the crash hub' },
      () => count(h, 'SELECT 1 FROM trustwork.legal_document_version WHERE hub_id = $1', [hubId])));
    await run('hub.legal_counsel_record', clients.chief, `${base}/legal/counsel-approvals`, { documentVersionIds: [doc.document.id], counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP', approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic review' },
      () => count(h, 'SELECT 1 FROM trustwork.counsel_approval WHERE hub_id = $1', [hubId]));
    await run('hub.legal_activate', clients.chief, `${base}/legal/${doc.document.id}/activate`, { expectedRevision: doc.document.revision, approvalId: null },
      () => count(h, "SELECT 1 FROM trustwork.second_person_approval WHERE hub_id = $1 AND action = 'legal.activate_document_version'", [hubId]));

    // Credential references.
    const credential = body<{ credential: { id: string } }>(await run('hub.credential_register', clients.steward, `${base}/credentials`, { provider: 'mail', adapter: 'fake', mode: 'fake', secret: { store: 'env', ref: 'MAIL_FAKE' } },
      () => count(h, 'SELECT 1 FROM trustwork.provider_credential_ref WHERE hub_id = $1', [hubId])));
    await run('hub.credential_activate', clients.chief, `${base}/credentials/${credential.credential.id}/activate`, { approvalId: null },
      () => count(h, "SELECT 1 FROM trustwork.provider_credential_ref WHERE hub_id = $1 AND status = 'active'", [hubId]));
    await run('hub.credential_retire', clients.chief, `${base}/credentials/${credential.credential.id}/retire`, {},
      () => count(h, "SELECT 1 FROM trustwork.provider_credential_ref WHERE hub_id = $1 AND status = 'retired'", [hubId]));

    // The participant route: an active text of a launched synthetic hub fixture (inserted as public by maintenance).
    const launched = await withMaintenance(admin, async (trx) => {
      const row = await trx.insertInto('hub').values({ slug: `synthetic-launched-${randomBytes(3).toString('hex')}`, lifecycle: 'public' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('hub_profile').values({ hub_id: row.id, node_id: nodeId, name: { en: 'Synthetic launched hub' }, default_locale: 'en', locales: ['en'], time_zone: 'UTC', currency: 'USD', created_by: founder.person_id }).execute();
      return row.id;
    });
    const draftDoc = await as(h, people.steward, (trx, ctx) => legalDocuments.draft(trx, ctx, launched, { kind: 'terms', locale: 'en', body: 'Synthetic terms of the launched hub' }));
    const counsel = await as(h, people.chief, (trx, ctx) => legalDocuments.recordCounselApproval(trx, ctx, launched, { documentVersionIds: [draftDoc.id], counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP', approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic review' }));
    const digest = computeDigest(legalActivationDigestInput({ id: draftDoc.id, hubId: launched, kind: 'terms', locale: 'en', version: draftDoc.version, bodyDigest: draftDoc.body_digest, counselApprovalId: counsel.id })).value;
    const stewardCtx = await ctxOf(h, people.steward);
    const request = await withPrincipal(h.pool, await principalFor(admin, people.steward), (trx) => approvals.request(trx, stewardCtx, { action: 'legal.activate_document_version', scope: { kind: 'hub', hubId: launched }, actionDigest: digest }));
    await as(h, people.chief, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await withPrincipal(h.pool, await principalFor(admin, people.steward), (trx) => legalDocuments.activate(trx, stewardCtx, draftDoc.id, null, request.id));
    await exactlyOnce({ action: 'hub.legal_accept', client: clients.participant, url: `/v1/hubs/${launched}/legal/${draftDoc.id}/accept`, body: { context: 'signup' },
      effects: () => count(h, 'SELECT 1 FROM trustwork.legal_acceptance WHERE person_id = $1', [people.participant]) });
  },
} satisfies CrashCase;
