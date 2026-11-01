import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createPool, withMaintenance, type DataPool } from '@trustwork/data';
import { AUTOMATION_DOMAINS, computeDigest, HUB_CONFIG_DOMAINS, LAUNCH_GATES, SENSITIVE_CONFIG_DOMAINS, SOFT_LAUNCH_GATES, type HubConfigDomain, type HubModes } from '@trustwork/contracts';
import {
  configActivationDigestInput, credentialActivationDigestInput, legalActivationDigestInput, lifecycleTransitionDigestInput, CONFIG_DOMAIN_SECOND_PERSON_ACTIONS, CONFIG_DOMAIN_PERMISSIONS,
  LEGAL_DOCUMENT_KINDS, RETENTION_CLASSES, type LegalDocumentKind,
} from '../../packages/contracts/src/hub-core.js';
import { hubConfig, hubs, launchGates, legalDocuments, providerCredentials } from '../../packages/data/src/repositories/hubs.js';
import { deploymentAttestations } from '../../packages/data/src/repositories/attestation.js';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import type { HubConfigVersionRow } from '../../packages/data/src/schema/hubs.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/hubs.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { seedFixtures } from '../data/helpers/seed.js';
import { actors, buildHubWorld, evidence, rejects, settle, syncKernel, US_HUB } from './helpers.js';

// Weight 2: the runtime pool races concurrent activations and transitions.
const db = await provisionTestDatabase('hubs_core', { weight: 2 });

const MODES_DEMO: HubModes = {
  dataMode: 'demo', registration: 'closed', modules: [], moderation: 'pre_moderate_all',
  automation: Object.fromEntries(AUTOMATION_DOMAINS.map((d) => [d, 'manual'])) as HubModes['automation'], searchEngineIndexing: false, maintenance: false,
};
const MODES_LIVE: HubModes = { ...MODES_DEMO, dataMode: 'live', registration: 'invite_only' };

/**
 * HUB-001 on real PostgreSQL under the runtime role: hubs, territories, hub-scoped staff, versioned configuration with a
 * current pointer and second-person activation, launch gates and the lifecycle guard, legal documents, credential
 * references and the retention policy. Every refusal is the database's own.
 */
test('hubs core: territories, scoped staff, versioned configuration, launch gates and the lifecycle', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 10 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const w = await buildHubWorld(db.admin);
  const a = actors(db.admin, runtime, w);
  const p = w.people;
  const count = async (query: string, params: unknown[] = []) => (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
  const draft = (personId: string, hubId: string, domain: HubConfigDomain, payload: Record<string, unknown>) => a.cmd(personId, (trx, ctx) => hubConfig.draft(trx, ctx, hubId, domain, payload));
  const activate = (personId: string, v: HubConfigVersionRow, approvalId: string | null = null) => a.cmd(personId, (trx, ctx) => hubConfig.activate(trx, ctx, v.id, null, approvalId));
  const activateSensitive = async (drafter: string, activator: string, v: HubConfigVersionRow) => {
    const action = CONFIG_DOMAIN_SECOND_PERSON_ACTIONS[v.domain as HubConfigDomain]!;
    const approval = await a.approve(activator, drafter, action, v.hub_id, configActivationDigestInput({ id: v.id, hubId: v.hub_id, domain: v.domain as HubConfigDomain, version: v.version, payloadDigest: v.payload_digest }));
    return activate(activator, v, approval);
  };
  const hubRow = async (hubId: string) => (await db.admin.query<{ lifecycle: string; revision: number }>('SELECT lifecycle, revision FROM trustwork.hub WHERE id = $1', [hubId])).rows[0]!;
  const transition = async (personId: string, hubId: string, to: string, approvalId: string | null = null) => {
    const { revision } = await hubRow(hubId);
    return a.cmd(personId, (trx, ctx) => hubs.transition(trx, ctx, hubId, to, revision, approvalId));
  };
  const approveTransition = async (requester: string, approver: string, hubId: string, to: 'soft_launch' | 'public') => {
    const h = await hubRow(hubId);
    return a.approve(requester, approver, to === 'public' ? 'hub.transition_public' : 'hub.transition_soft_launch', hubId,
      lifecycleTransitionDigestInput({ hubId, from: h.lifecycle as 'preparing', to, revision: h.revision }));
  };

  await t.test('vocabularies match the contracts', async () => {
    const q = async <T>(text: string, params: unknown[] = []) => (await db.admin.query<{ v: T }>(text, params)).rows[0]!.v;
    assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_config_domains() AS v'), [...HUB_CONFIG_DOMAINS]);
    assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_sensitive_domains() AS v'), [...SENSITIVE_CONFIG_DOMAINS]);
    assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_launch_gates() AS v'), [...LAUNCH_GATES]);
    assert.deepEqual(await q<string[]>("SELECT trustwork.hubs_required_gates('soft_launch') AS v"), [...SOFT_LAUNCH_GATES]);
    assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_legal_kinds() AS v'), [...LEGAL_DOCUMENT_KINDS]);
    assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_retention_classes() AS v'), [...RETENTION_CLASSES]);
    for (const domain of HUB_CONFIG_DOMAINS) {
      assert.equal(await q<string | null>('SELECT trustwork.hubs_domain_action($1) AS v', [domain]), CONFIG_DOMAIN_SECOND_PERSON_ACTIONS[domain] ?? null, domain);
      assert.deepEqual(await q<string[]>('SELECT trustwork.hubs_domain_permissions($1) AS v', [domain]), [CONFIG_DOMAIN_PERMISSIONS[domain], 'admin.config.edit'], domain);
    }
    assert.deepEqual(Object.keys(CONFIG_DOMAIN_SECOND_PERSON_ACTIONS).sort(), [...SENSITIVE_CONFIG_DOMAINS].sort(), 'every sensitive domain, and only those, names its action');
    const id = randomUUID();
    const hubId = randomUUID();
    assert.equal(await q<string>("SELECT trustwork.hubs_config_digest($1, $2, 'residency', 3, $3) AS v", [id, hubId, 'a'.repeat(64)]),
      computeDigest(configActivationDigestInput({ id, hubId, domain: 'residency', version: 3, payloadDigest: 'a'.repeat(64) })).value);
    assert.equal(await q<string>("SELECT trustwork.hubs_config_digest($1, $2, 'identity', 1, $3) AS v", [id, hubId, 'b'.repeat(64)]),
      computeDigest(configActivationDigestInput({ id, hubId, domain: 'identity', version: 1, payloadDigest: 'b'.repeat(64) })).value, 'non-sensitive domains digest a null action');
    assert.equal(await q<string>("SELECT trustwork.hubs_transition_digest($1, 'preparing', 'soft_launch', 7) AS v", [hubId]),
      computeDigest(lifecycleTransitionDigestInput({ hubId, from: 'preparing', to: 'soft_launch', revision: 7 })).value);
    assert.equal(await q<string>("SELECT trustwork.hubs_legal_digest($1, $2, 'terms', 'en', 2, $3, $4) AS v", [id, hubId, 'c'.repeat(64), id]),
      computeDigest(legalActivationDigestInput({ id, hubId, kind: 'terms', locale: 'en', version: 2, bodyDigest: 'c'.repeat(64), counselApprovalId: id })).value);
    assert.equal(await q<string>("SELECT trustwork.hubs_credential_digest($1, $2, 'stripe', 'stripe', 'live', 'env', 'PAYMENTS_KEY') AS v", [id, hubId]),
      computeDigest(credentialActivationDigestInput({ id, hubId, provider: 'stripe', adapter: 'stripe', mode: 'live', secretStore: 'env', secretRef: 'PAYMENTS_KEY' })).value);
    const payload = { schemaVersion: 1, languages: { default: 'en', enabled: ['en', 'es'] } };
    assert.equal(await q<string>('SELECT trustwork.admin_digest($1::jsonb) AS v', [JSON.stringify(payload)]), computeDigest(payload).value, 'payload digests match');
  });

  let hubA = '';
  let hubB = '';
  await t.test('a restricted territory is rejected at hub creation (engine list, regions and places inside restricted regions, unsynced list)', async () => {
    await a.assignSensitive({ personId: p.operator, role: 'node-operator', scope: { kind: 'node', nodeId: w.nodeId } });
    // Before the restricted list is synced every place counts as restricted (fail closed).
    await rejects(a.createHub('synthetic-unsynced'), '23514', 'kernel.restricted_place');
    await syncKernel(db.admin);
    for (const territories of [
      [{ level: 'country', code: 'RU' }], [{ level: 'region', code: 'UA-43' }], [{ level: 'place', code: 'UA-43:simferopol' }], [{ level: 'country', code: 'IR' }],
      [{ level: 'country', code: 'KP' }], [{ level: 'country', code: 'CU' }], [{ level: 'region', code: 'UA-14' }],
      [{ level: 'country', code: 'US' }, { level: 'region', code: 'UA-09' }],
    ] as const) {
      await rejects(a.createHub(`synthetic-r-${randomBytes(3).toString('hex')}`, { ...US_HUB, territories: [...territories] }), '23514', 'kernel.restricted_place');
    }
    await rejects(a.createHub('synthetic-ru-pack', { ...US_HUB, countryPack: { code: 'RU', version: '1' }, territories: [{ level: 'country', code: 'US' }] }), '23514', 'kernel.restricted_place');
    assert.equal(await count('SELECT 1 FROM trustwork.hub'), 0, 'nothing was created');
    hubA = (await a.createHub('synthetic-us-demo')).hub_id;
    hubB = (await a.createHub('synthetic-ge-demo', { name: { en: 'Synthetic Georgia demo hub', ka: 'Synthetic Georgia demo hub' }, defaultLocale: 'en', locales: ['en', 'ka'], timeZone: 'Asia/Tbilisi', currency: 'GEL', countryPack: null, territories: [{ level: 'country', code: 'GE' }] })).hub_id;
    const row = await hubRow(hubA);
    assert.equal(row.lifecycle, 'draft', 'a hub is born a draft');
    assert.deepEqual((await db.admin.query('SELECT code FROM trustwork.hub_territory WHERE hub_id = $1 ORDER BY code', [hubA])).rows.map((r) => r.code), ['US', 'US-CA', 'US-CA:san-diego']);
    assert.equal(await count("SELECT 1 FROM trustwork.launch_gate WHERE hub_id = $1 AND state = 'open'", [hubA]), LAUNCH_GATES.length, 'every gate starts open');
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.created' AND scope_kind = 'node' AND object_id = $1", [hubA]), 1, 'creation is audited at the node');

    await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: hubA } });
    await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: hubA } });
    await a.assign({ personId: p.moderator, role: 'moderator', scope: { kind: 'hub', hubId: hubA } });
    await a.assignSensitive({ personId: p.otherOwner, role: 'hub-owner', scope: { kind: 'hub', hubId: hubB } });
  });

  await t.test('a restricted territory is rejected when added later, and a payload naming a restricted place is refused', async () => {
    for (const [level, code] of [['country', 'RU'], ['region', 'UA-40'], ['place', 'UA-40:sevastopol'], ['country', 'CU']] as const) {
      await rejects(a.cmd(p.owner, (trx, ctx) => hubs.addTerritory(trx, ctx, hubA, { level, code })), '23514', 'kernel.restricted_place');
    }
    const offered = await rejects(draft(p.owner, hubA, 'country', { schemaVersion: 1, countries: { default: 'US', offered: ['US', 'MX', 'RU'] } }), '23514', 'hubs.restricted_place');
    assert.equal(offered.detail, 'RU');
    await rejects(draft(p.owner, hubA, 'identity', { schemaVersion: 1, languages: { byCountry: { IR: 'en' } } }), '23514', 'hubs.restricted_place');
    await rejects(draft(p.owner, hubA, 'sources', { feeds: [{ jurisdiction: 'UA-43:simferopol' }] }), '23514', 'hubs.restricted_place');
    const added = await a.cmd(p.owner, (trx, ctx) => hubs.addTerritory(trx, ctx, hubA, { level: 'place', code: 'US-CA:chula-vista' }));
    await rejects(a.cmd(p.owner, (trx, ctx) => hubs.addTerritory(trx, ctx, hubA, { level: 'place', code: 'US-CA:chula-vista' })), '23505', 'hubs.territory_exists');
    await a.cmd(p.owner, (trx, ctx) => hubs.removeTerritory(trx, ctx, hubA, added.id));
    await rejects(a.cmd(p.otherOwner, async (trx, ctx) => {
      const only = (await db.admin.query('SELECT id FROM trustwork.hub_territory WHERE hub_id = $1', [hubB])).rows[0]!.id as string;
      return hubs.removeTerritory(trx, ctx, hubB, only);
    }), '23514', 'hubs.territory_required');
  });

  await t.test('negative authorization: participants, staff without a permission, staff of another hub, hub staff at the node, missing elevations, direct writes', async () => {
    const tries = (personId: string): Array<() => Promise<unknown>> => [
      () => draft(personId, hubA, 'identity', { schemaVersion: 1 }),
      () => a.cmd(personId, (trx, ctx) => hubs.addTerritory(trx, ctx, hubA, { level: 'place', code: 'US-CA:oceanside' })),
      () => a.cmd(personId, (trx, ctx) => launchGates.check(trx, ctx, hubA, 'i18n_complete', evidence())),
      () => a.cmd(personId, async (trx, ctx) => hubs.transition(trx, ctx, hubA, 'preparing', (await hubRow(hubA)).revision, null)),
      () => a.cmd(personId, (trx, ctx) => legalDocuments.draft(trx, ctx, hubA, { kind: 'terms', locale: 'en', body: 'Synthetic terms' })),
      () => a.cmd(personId, (trx, ctx) => providerCredentials.register(trx, ctx, hubA, { provider: 'fake_mail', adapter: 'fake', mode: 'fake', secretStore: 'env', secretRef: 'MAIL_KEY' })),
    ];
    for (const key of ['outsider', 'moderator', 'otherOwner', 'founder2'] as const) {
      for (const attempt of tries(p[key])) await rejects(attempt(), key === 'outsider' ? '42501' : '42501', 'admin.forbidden');
    }
    // Hub staff never create hubs (a node-only permission) and never act on another hub.
    await rejects(a.cmd(p.owner, (trx, ctx) => hubs.create(trx, ctx, { slug: 'synthetic-by-owner', ...US_HUB })), '42501', 'admin.forbidden');
    await rejects(draft(p.owner, hubB, 'identity', { schemaVersion: 1 }), '42501', 'admin.forbidden');
    // No live elevation, a foreign one, an expired one.
    const ctx = await a.elevate(p.owner);
    await rejects(a.as(p.owner, (trx) => hubConfig.draft(trx, { ...ctx, elevationId: randomUUID() }, hubA, 'identity', { schemaVersion: 1 })), '42501', 'admin.elevation_required');
    const foreign = await a.elevate(p.officer);
    await rejects(a.as(p.owner, (trx) => hubConfig.draft(trx, { ...ctx, elevationId: foreign.elevationId }, hubA, 'identity', { schemaVersion: 1 })), '42501', 'admin.elevation_required');
    await rejects(runtime.query("SELECT trustwork.hubs_draft_config($1::jsonb, $2, 'identity', '{}'::jsonb, 'console')", [JSON.stringify(ctx), hubA]), '28000', 'access.no_principal');
    // The runtime role never writes these tables directly.
    for (const statement of [
      "INSERT INTO trustwork.hub_config_version (hub_id, domain, version, payload, payload_digest, reason, drafted_by) VALUES ($1, 'identity', 99, '{}', repeat('0', 64), 'x', $2)",
      "UPDATE trustwork.launch_gate SET state = 'passed' WHERE hub_id = $1 AND $2::uuid IS NOT NULL",
      "UPDATE trustwork.hub SET lifecycle = 'public' WHERE id = $1 AND $2::uuid IS NOT NULL",
      "INSERT INTO trustwork.hub_territory (hub_id, level, code) VALUES ($1, 'country', 'MX') RETURNING $2::uuid",
    ]) await rejects(a.as(p.owner, (trx) => sql.raw(statement.replace('$1', `'${hubA}'`).replace('$2', `'${p.owner}'`)).execute(trx)), '42501');
    assert.equal(await count('SELECT 1 FROM trustwork.hub_config_version'), 0);
  });

  await t.test('row-level security: hub staff read their hub before launch; another hub\'s staff and participants never see drafts or configuration', async () => {
    await draft(p.owner, hubA, 'identity', { schemaVersion: 1, languages: { default: 'en', enabled: ['en', 'es'] } });
    const sees = async (personId: string) => a.as(personId, async (trx) => ({
      hub: (await hubs.get(trx, hubA)) !== undefined, profile: (await hubs.profile(trx, hubA)) !== undefined, territories: (await hubs.territories(trx, hubA)).length,
      versions: (await hubConfig.list(trx, hubA)).length, gates: (await launchGates.list(trx, hubA)).length,
    }));
    assert.deepEqual(await sees(p.owner), { hub: true, profile: true, territories: 3, versions: 1, gates: LAUNCH_GATES.length });
    assert.deepEqual(await sees(p.operator), { hub: true, profile: true, territories: 3, versions: 1, gates: LAUNCH_GATES.length }, 'node staff cover every hub');
    for (const key of ['otherOwner', 'outsider', 'moderator'] as const) assert.deepEqual(await sees(p[key]), { hub: false, profile: false, territories: 0, versions: 0, gates: 0 }, key);
    await rejects(a.as(p.outsider, (trx) => hubs.blockers(trx, hubA, 'public')), 'P0002', 'admin.not_found');
  });

  let identityV1: HubConfigVersionRow;
  await t.test('configuration versions are immutable, numbered per domain, with one current pointer', async () => {
    identityV1 = (await a.as(p.owner, (trx) => hubConfig.list(trx, hubA, 'identity')))[0]!;
    assert.equal(identityV1.version, 1);
    assert.equal(identityV1.payload_digest, computeDigest(identityV1.payload).value, 'the database digests what it stores');
    const active = await activate(p.owner, identityV1);
    assert.equal(active.status, 'active');
    assert.equal(active.activated_by, p.owner, 'a non-sensitive domain is activated by one person holding its permission');
    assert.equal(active.approval_id, null);
    const v2 = await draft(p.officer, hubA, 'identity', { schemaVersion: 1, languages: { default: 'en', enabled: ['en', 'es'] }, brand: { overlay: null } });
    const v3 = await draft(p.owner, hubA, 'identity', { schemaVersion: 1, languages: { default: 'es', enabled: ['en', 'es'] } });
    assert.deepEqual([v2.version, v3.version], [2, 3]);
    await activate(p.owner, v3);
    await rejects(activate(p.owner, v2), '23514', 'hubs.config_stale');
    await a.cmd(p.owner, (trx, ctx) => hubConfig.cancel(trx, ctx, v2.id));
    await rejects(activate(p.owner, v3), '23514', 'hubs.invalid_transition');
    const current = await a.as(p.owner, (trx) => hubConfig.current(trx, hubA));
    assert.deepEqual(current.map((v) => [v.domain, v.version, v.status]), [['identity', 3, 'active']]);
    assert.deepEqual((await db.admin.query('SELECT version, status FROM trustwork.hub_config_version WHERE hub_id = $1 ORDER BY version', [hubA])).rows.map((r) => `${r.version}:${r.status}`),
      ['1:superseded', '2:cancelled', '3:active']);
    // Every writer, maintenance included: no edit, no deletion, no moving the pointer back.
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub_config_version').set({ payload: { schemaVersion: 1 } }).where('id', '=', v3.id).execute()), '23000', 'hubs.version_immutable');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('hub_config_version').where('id', '=', identityV1.id).execute()), '23000', 'audit.append_only');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub_config_current').set({ version_id: identityV1.id, version: 1 }).where('hub_id', '=', hubA).execute()), '23000', 'hubs.config_stale');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub_config_version').set({ status: 'draft' }).where('id', '=', v3.id).execute()), '23514', 'hubs.invalid_transition');
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE hub_id = $1 AND action IN ('hub.config_drafted', 'hub.config_activated', 'hub.config_cancelled') AND scope_kind = 'hub'", [hubA]), 6);
  });

  await t.test('sensitive configuration changes require a different approver (and an activator other than the drafter)', async () => {
    const residency = await draft(p.owner, hubA, 'residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] });
    const digestInput = configActivationDigestInput({ id: residency.id, hubId: hubA, domain: 'residency', version: residency.version, payloadDigest: residency.payload_digest });
    // The drafter never activates a sensitive version, even with someone else's approval.
    const forDrafter = await a.approve(p.owner, p.officer, 'hub.change_residency', hubA, digestInput);
    await rejects(activate(p.owner, residency, forDrafter), '42501', 'admin.self_approval');
    // Another person without an approval, or approving their own request.
    await rejects(activate(p.officer, residency), '42501', 'admin.approval_required');
    const own = await a.cmd(p.officer, (trx, ctx) => approvals.request(trx, ctx, { action: 'hub.change_residency', scope: { kind: 'hub', hubId: hubA }, actionDigest: computeDigest(digestInput).value }));
    await rejects(a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, own.id, 'approve', computeDigest(digestInput).value)), '42501', 'admin.self_approval');
    await rejects(activate(p.officer, residency, own.id), '23514', 'admin.approval_not_approved');
    // An approval of another digest (another version, the wrong action) never fits.
    const other = await draft(p.owner, hubA, 'residency', { hostingCountry: 'US', hostingRegion: 'US-CA', personalDataCountries: ['US'] });
    const wrong = await a.approve(p.officer, p.owner, 'hub.change_residency', hubA, configActivationDigestInput({ id: other.id, hubId: hubA, domain: 'residency', version: other.version, payloadDigest: other.payload_digest }));
    await rejects(activate(p.officer, residency, wrong), '23514', 'admin.approval_mismatch');
    const wrongAction = await a.approve(p.officer, p.owner, 'legal.activate_document_version', hubA, digestInput);
    await rejects(activate(p.officer, residency, wrongAction), '23514', 'admin.approval_mismatch');
    // Maintenance cannot shortcut it either.
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub_config_version').set({ status: 'active', activated_by: p.officer, activated_at: new Date(), effective_from: new Date() }).where('id', '=', residency.id).execute()), '42501', 'admin.approval_required');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub_config_version').set({ status: 'active', activated_by: p.officer, activated_at: new Date(), effective_from: new Date(), approval_id: forDrafter }).where('id', '=', residency.id).execute()), '42501', 'admin.approval_required');
    // The officer asks, the drafter approves, the officer activates.
    const approval = await a.approve(p.officer, p.owner, 'hub.change_residency', hubA, digestInput);
    const active = await activate(p.officer, residency, approval);
    assert.equal(active.status, 'active');
    assert.equal(active.activated_by, p.officer);
    assert.equal(active.approval_id, approval);
    await rejects(activate(p.officer, other, approval), '23514', 'admin.approval_consumed');
    const audit = (await db.admin.query("SELECT actor_person_id, second_approver_person_id, approval_id FROM trustwork.admin_audit_event WHERE action = 'hub.config_activated' AND object_id = $1", [residency.id])).rows;
    assert.deepEqual(audit, [{ actor_person_id: p.officer, second_approver_person_id: p.owner, approval_id: approval }], 'the audit names the second approver');
  });

  await t.test('a contradicting deployment-location attestation refuses configuration that states another location', async () => {
    await a.cmd(p.operator, (trx, ctx) => deploymentAttestations.attest(trx, ctx, { operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE', hostingCountry: 'US', hostingRegion: null, gateMode: 'upstream_gate', supersedes: null, statementVersion: 'deployment-location-1' }));
    const moved = await rejects(draft(p.owner, hubA, 'residency', { hostingCountry: 'CA', hostingRegion: null, personalDataCountries: ['CA'] }), '23514', 'hubs.attestation_contradicted');
    assert.equal(moved.detail, 'hostingCountry');
    await rejects(draft(p.owner, hubA, 'legal', { operatorEntity: { name: 'Synthetic Operator LLC', registrationRef: null, legalNoticeContact: 'legal@example.invalid' }, operatorEntityCountry: 'US', operatorEntityRegion: 'US-NY' }), '23514', 'hubs.attestation_contradicted');
    // A draft made before the attestation is checked again at activation.
    const stale = (await db.admin.query("SELECT * FROM trustwork.hub_config_version WHERE hub_id = $1 AND domain = 'residency' AND status = 'draft'", [hubA])).rows[0] as HubConfigVersionRow;
    assert.equal(stale.payload.hostingRegion, 'US-CA');
    const approval = await a.approve(p.officer, p.owner, 'hub.change_residency', hubA, configActivationDigestInput({ id: stale.id, hubId: hubA, domain: 'residency', version: stale.version, payloadDigest: stale.payload_digest }));
    await rejects(activate(p.officer, stale, approval), '23514', 'hubs.attestation_contradicted');
    await a.cmd(p.owner, (trx, ctx) => hubConfig.cancel(trx, ctx, stale.id));
  });

  await t.test('hub-added restricted places: a cited legal basis, a second person, add only, and refused as territories and in payloads', async () => {
    await rejects(draft(p.officer, hubA, 'jurisdiction', { addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: '', url: null } }] }), '23514', 'hubs.added_place_invalid');
    await rejects(draft(p.officer, hubA, 'jurisdiction', { addedRestrictedPlaces: [{ code: 'US-CA', legalBasis: { citation: 'Synthetic state order 1', url: null } }] }), '23514', 'hubs.territory_restricted');
    const v1 = await draft(p.officer, hubA, 'jurisdiction', { addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: 'Synthetic order 14-1', url: null } }] });
    await activateSensitive(p.officer, p.owner, v1);
    await rejects(a.cmd(p.owner, (trx, ctx) => hubs.addTerritory(trx, ctx, hubA, { level: 'country', code: 'VE' })), '23514', 'kernel.restricted_place');
    await rejects(draft(p.owner, hubA, 'country', { schemaVersion: 1, countries: { offered: ['US', 'VE'] } }), '23514', 'hubs.restricted_place');
    const removal = await rejects(draft(p.officer, hubA, 'jurisdiction', { addedRestrictedPlaces: [] }), '23514', 'hubs.restricted_place_removed');
    assert.equal(removal.detail, 'VE');
    const v2 = await draft(p.officer, hubA, 'jurisdiction', { addedRestrictedPlaces: [{ code: 'VE', legalBasis: { citation: 'Synthetic order 14-1', url: null } }, { code: 'NI', legalBasis: { citation: 'Synthetic order 14-2', url: null } }] });
    await activateSensitive(p.officer, p.owner, v2);
    assert.deepEqual((await db.admin.query('SELECT trustwork.hubs_added_places($1) AS v', [hubA])).rows[0].v, ['NI', 'VE']);
    // Hub additions never reach other hubs: hub B may still name VE.
    await draft(p.otherOwner, hubB, 'country', { schemaVersion: 1, countries: { offered: ['GE', 'VE'] } });
  });

  await t.test('privacy settings derive the retention policy; malformed retention is refused', async () => {
    await rejects(draft(p.owner, hubA, 'privacy', { retention: [{ class: 'accounting', minPeriod: 'P7Y', maxPeriod: 'P3Y' }] }), '23514', 'hubs.retention_invalid');
    await rejects(draft(p.owner, hubA, 'privacy', { retention: [{ class: 'forever', minPeriod: null, maxPeriod: null }] }), '23514', 'hubs.retention_invalid');
    await rejects(draft(p.owner, hubA, 'privacy', { retention: [{ class: 'case', minPeriod: '7 years', maxPeriod: null }] }), '23514', 'hubs.retention_invalid');
    const v = await draft(p.owner, hubA, 'privacy', { retention: [
      { class: 'accounting', minPeriod: 'P7Y', maxPeriod: null, packFactRef: null, disclosureTextKey: 'privacy.retention.accounting' },
      { class: 'case', minPeriod: 'P1Y', maxPeriod: 'P3Y', packFactRef: null, disclosureTextKey: null },
    ] });
    await activateSensitive(p.owner, p.officer, v);
    assert.deepEqual((await db.admin.query('SELECT class, min_period, max_period FROM trustwork.retention_policy WHERE config_version_id = $1 ORDER BY class', [v.id])).rows,
      [{ class: 'accounting', min_period: 'P7Y', max_period: null }, { class: 'case', min_period: 'P1Y', max_period: 'P3Y' }]);
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('retention_policy').set({ max_period: 'P1Y' }).where('config_version_id', '=', v.id).execute()), '23000', 'audit.append_only');
    assert.equal((await a.as(p.owner, (trx) => hubConfig.retention(trx, hubA))).length, 2);
    assert.equal((await a.as(p.outsider, (trx) => hubConfig.retention(trx, hubA))).length, 0, 'disclosed publicly only from soft launch');
  });

  await t.test('no hub setting widens data access: forbidden keys at any depth, no policy reads configuration, private rows stay private', async () => {
    for (const payload of [
      { visibility: 'public' }, { staffReadPrivate: true }, { nested: [{ grantRole: 'auditor' }] }, { caseAccess: { hours: 999 } }, { bypassRls: true },
      { shareWith: ['peers'] }, { rankBoost: 3 }, { score: 1 }, { audience: 'everyone' }, { permissions: ['admin.staff.assign'] },
    ]) {
      await rejects(draft(p.owner, hubA, 'matching', payload), '23514', 'hubs.access_widening');
      await rejects(draft(p.owner, hubA, 'modes', payload), '23514', 'hubs.access_widening');
    }
    // No row-level security policy or access function outside this module reads a configuration table.
    const policies = (await db.admin.query<{ tablename: string; policyname: string; qual: string | null; with_check: string | null }>(
      "SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'trustwork'")).rows;
    const configTables = /hub_config_version|hub_config_current|launch_gate|retention_policy|hubs_active_payload|hubs_added_places/;
    const own = new Set(Object.keys(TABLE_COLUMNS));
    for (const policy of policies) {
      if (own.has(policy.tablename)) continue;
      assert.doesNotMatch(`${policy.qual ?? ''} ${policy.with_check ?? ''}`, configTables, `${policy.tablename}.${policy.policyname}`);
    }
    const functions = (await db.admin.query<{ proname: string; prosrc: string }>("SELECT p.proname, p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'trustwork'")).rows;
    // KEYS-001 reads the residency domain only to narrow egress (private data stays in the hub's residency countries);
    // it grants nothing and is no access function.
    // HUB-005 validates activation and restricts a quote action after checking its actual party; none of these
    // helpers changes an RLS policy or grants private-data access (negative evidence: tests/hubs/jurisdiction).
    // PAY-001 only narrows admission to the active payments config; it grants no data access. payments_candidate_lock
    // takes SHARE locks on the configuration it reads later in the same transaction (serialization only, no read).
    // PAY-001 only narrows admission to the active payments config; it grants no data access.
    const narrowingReaders = new Set(['payments_candidate_lock', 'payments_collecting_candidates', 'payments_source_places', 'payments_route_available', 'providers_residency', 'jurisdiction_config_guard', 'jurisdiction_language_guard', 'jurisdiction_resolve_quote', 'jurisdiction_preflight']);
    // These four exact readers preserve the original HUB implementations behind the KEYS ordering wrapper.
    // No generic wrapper prefix is exempt, and runtime roles must not invoke the unfenced bodies.
    const internalHubReaders = ['callback_unfenced_hubs_activate_config', 'callback_unfenced_hubs_cancel_config', 'callback_unfenced_hubs_create', 'callback_unfenced_hubs_draft_config'];
    for (const name of internalHubReaders) {
      const rows: { args: string; app: boolean; worker: boolean }[] = (await db.admin.query<{ args: string; app: boolean; worker: boolean }>(
        "SELECT oidvectortypes(p.proargtypes) AS args, has_function_privilege('trustwork_app',p.oid,'EXECUTE') AS app, has_function_privilege('trustwork_worker',p.oid,'EXECUTE') AS worker FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trustwork' AND p.proname=$1", [name])).rows;
      assert.equal(rows.length, 1, name);
      assert.deepEqual([rows[0]!.app, rows[0]!.worker], [false, false], name);
      for (const role of ['trustwork_app', 'trustwork_worker']) {
        const client = await db.admin.connect();
        try {
          await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
          await assert.rejects(client.query(`SELECT trustwork.${name}(${rows[0]!.args.split(', ').map(type => `NULL::${type}`).join(',')})`),
            (error: unknown) => (error as { code?: string }).code === '42501');
        } finally { await client.query('ROLLBACK'); client.release(); }
      }
      narrowingReaders.add(name);
    }
    for (const fn of functions) if (!fn.proname.startsWith('hubs_') && !narrowingReaders.has(fn.proname)) assert.doesNotMatch(fn.prosrc, configTables, fn.proname);

    // Private rows visible to hub staff and to a participant are the same before and after configuring every domain.
    const seed = await seedFixtures(db.admin);
    const visible = (personId: string) => a.as(personId, async (trx) => {
      const out: Record<string, number> = {};
      for (const table of ['company_private', 'project', 'permission_grant', 'object_participation', 'person', 'membership', 'email_binding', 'session', 'credential']) {
        out[table] = Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(`trustwork.${table}`)}`.execute(trx)).rows[0]!.n);
      }
      return out;
    });
    const before = { owner: await visible(p.owner), officer: await visible(p.officer), petr: await visible(seed.people.petr) };
    for (const domain of HUB_CONFIG_DOMAINS.filter((d) => !SENSITIVE_CONFIG_DOMAINS.includes(d) && !['identity', 'country', 'modes'].includes(d))) {
      await activate(p.owner, await draft(p.owner, hubA, domain, { policy: 'synthetic', searchEngineIndexing: true, includeDrafts: true, retentionDays: 1 }));
    }
    await activate(p.owner, await draft(p.owner, hubA, 'modes', { ...MODES_DEMO, searchEngineIndexing: false }));
    // `agents` is left out: AGT-003 activates only documents it validated (tests/agent-modules).
    for (const domain of ['egress', 'federation', 'providers', 'payments'] as const) {
      await activateSensitive(p.owner, p.officer, await draft(p.owner, hubA, domain, { policy: 'synthetic', allowAllClasses: true }));
    }
    assert.deepEqual({ owner: await visible(p.owner), officer: await visible(p.officer), petr: await visible(seed.people.petr) }, before);
  });

  await t.test('concurrency: one of two activations of the same draft wins; concurrent drafts get contiguous versions; one approval is consumed once', async () => {
    const v = await draft(p.owner, hubA, 'events', { policy: 'synthetic-race' });
    const results = await Promise.all([settle(activate(p.owner, v)), settle(activate(p.officer, v))]);
    assert.equal(results.filter((r) => r === null).length, 1, 'exactly one activation');
    assert.equal(results.find((r) => r !== null)?.hint, 'hubs.invalid_transition');
    const drafts = await Promise.all(Array.from({ length: 6 }, (_, i) => draft(i % 2 ? p.owner : p.officer, hubA, 'learning', { policy: `synthetic-${i}` })));
    const versions = drafts.map((d) => d.version).sort((x, y) => x - y);
    const first = versions[0]!;
    assert.deepEqual(versions, Array.from({ length: 6 }, (_, i) => first + i));
    // Two activations of two versions racing under one approval: the approval is consumed once.
    const r1 = await draft(p.owner, hubA, 'residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'], note: 'Synthetic race one' });
    const approval = await a.approve(p.officer, p.owner, 'hub.change_residency', hubA, configActivationDigestInput({ id: r1.id, hubId: hubA, domain: 'residency', version: r1.version, payloadDigest: r1.payload_digest }));
    const raced = await Promise.all([settle(activate(p.officer, r1, approval)), settle(activate(p.officer, r1, approval))]);
    assert.equal(raced.filter((r) => r === null).length, 1);
    assert.equal(await count("SELECT 1 FROM trustwork.hub_config_version WHERE hub_id = $1 AND domain = 'residency' AND status = 'active'", [hubA]), 1, 'one active version');
    // Two transitions of one hub from the same revision: the row lock lets one through, the other sees a newer revision.
    const { revision } = await hubRow(hubB);
    const both = await Promise.all([settle(a.cmd(p.otherOwner, (trx, ctx) => hubs.transition(trx, ctx, hubB, 'preparing', revision, null))),
      settle(a.cmd(p.otherOwner, (trx, ctx) => hubs.transition(trx, ctx, hubB, 'preparing', revision, null)))]);
    assert.equal(both.filter((r) => r === null).length, 1, 'exactly one transition');
    assert.equal(both.find((r) => r !== null)?.hint, 'hubs.revision_conflict');
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action = 'hub.lifecycle_changed' AND object_id = $1", [hubB]), 1);
  });

  await t.test('the reference hub stays demo-only: demo data blocks soft launch whatever else is ready', async () => {
    await transition(p.owner, hubA, 'preparing');
    const blockers = await a.as(p.owner, (trx) => hubs.blockers(trx, hubA, 'soft_launch'));
    assert.ok(blockers.includes('modes:demo_data_only_before_soft_launch'), blockers.join(','));
    await rejects(a.cmd(p.owner, (trx, ctx) => launchGates.check(trx, ctx, hubA, 'demo_data_purged', evidence())), '23514', 'hubs.gate_precondition');
  });

  // A synthetic hub for rehearsing a launch (never the reference hub, which stays demo-only).
  let hubC = '';
  await t.test('a hub cannot go public (or soft launch) with an open launch gate; with every gate and a second person it can', async () => {
    hubC = (await a.createHub('synthetic-launch-rehearsal', { name: { en: 'Synthetic launch rehearsal hub' }, defaultLocale: 'en', locales: ['en'], timeZone: 'Asia/Tbilisi', currency: 'GEL', countryPack: null, territories: [{ level: 'country', code: 'GE' }] })).hub_id;
    await a.assignSensitive({ personId: p.owner, role: 'hub-owner', scope: { kind: 'hub', hubId: hubC } });
    await a.assignSensitive({ personId: p.officer, role: 'compliance-officer', scope: { kind: 'hub', hubId: hubC } });
    await transition(p.owner, hubC, 'preparing');
    // Open gates: refused with the list, with or without an approval; maintenance cannot force it.
    const open = await rejects(transition(p.owner, hubC, 'soft_launch'), '23514', 'hubs.launch_gate_open');
    assert.deepEqual(open.detail!.split(',').filter((b) => b.startsWith('gate:')).sort(), SOFT_LAUNCH_GATES.map((g) => `gate:${g}`).sort());
    await rejects(transition(p.owner, hubC, 'public'), '23514', 'hubs.transition_not_allowed');
    await rejects(withMaintenance(db.admin, (trx) => trx.updateTable('hub').set({ lifecycle: 'soft_launch' }).where('id', '=', hubC).execute()), '23514', 'hubs.launch_gate_open');
    // A gate the engine cannot confirm yet is not passed on a person's word.
    for (const gate of ['data_residency_configured', 'two_staff_with_second_factor', 'legal_documents_counsel_approved', 'operator_recorded_and_screened', 'ai_egress_policy_reviewed'] as const) {
      await rejects(a.cmd(p.owner, (trx, ctx) => launchGates.check(trx, ctx, hubC, gate, evidence())), '23514', 'hubs.gate_precondition');
    }

    // Satisfy the soft-launch gates for real.
    await activateSensitive(p.owner, p.officer, await draft(p.owner, hubC, 'legal', { operatorEntity: { name: 'Synthetic Operator LLC', registrationRef: null, legalNoticeContact: 'legal@example.invalid' }, operatorEntityCountry: 'US', operatorEntityRegion: 'US-DE' }));
    await activateSensitive(p.owner, p.officer, await draft(p.owner, hubC, 'residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'] }));
    await activateSensitive(p.owner, p.officer, await draft(p.owner, hubC, 'egress', { defaultNonPublic: 'deny' }));
    await activate(p.owner, await draft(p.owner, hubC, 'modes', MODES_LIVE));
    const docs: string[] = [];
    for (const kind of ['terms', 'privacy_notice', 'sanctions_section', 'community_rules'] as LegalDocumentKind[]) {
      docs.push((await a.cmd(p.owner, (trx, ctx) => legalDocuments.draft(trx, ctx, hubC, { kind, locale: 'en', body: `Synthetic ${kind} text` }))).id);
    }
    await rejects(a.cmd(p.owner, (trx, ctx) => legalDocuments.draft(trx, ctx, hubC, { kind: 'terms', locale: 'ru', body: 'Synthetic' })), '23514', 'hubs.locale_not_in_hub');
    const firstDoc = (await db.admin.query('SELECT * FROM trustwork.legal_document_version WHERE id = $1', [docs[0]])).rows[0];
    await rejects(a.cmd(p.officer, (trx, ctx) => legalDocuments.activate(trx, ctx, firstDoc.id, null, null)), '23514', 'hubs.counsel_approval_required');
    const counsel = await a.cmd(p.officer, (trx, ctx) => legalDocuments.recordCounselApproval(trx, ctx, hubC, { documentVersionIds: docs, counselName: 'Synthetic Counsel', firm: 'Synthetic Firm LLP', approvedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), scopeNote: 'Synthetic review of the launch texts' }));
    await rejects(a.cmd(p.officer, (trx, ctx) => legalDocuments.activate(trx, ctx, firstDoc.id, null, null)), '42501', 'admin.approval_required');
    for (const id of docs) {
      const d = (await db.admin.query('SELECT * FROM trustwork.legal_document_version WHERE id = $1', [id])).rows[0];
      const approval = await a.approve(p.officer, p.owner, 'legal.activate_document_version', hubC, legalActivationDigestInput({ id, hubId: hubC, kind: d.kind, locale: d.locale, version: d.version, bodyDigest: d.body_digest, counselApprovalId: counsel.id }));
      await a.cmd(p.officer, (trx, ctx) => legalDocuments.activate(trx, ctx, id, null, approval));
    }
    // Two staff with distinct roles and second factors.
    await withMaintenance(db.admin, async (trx) => {
      for (const person of [p.owner, p.officer]) await trx.insertInto('second_factor').values({ id: randomUUID(), person_id: person, kind: 'totp', state: 'active', secret_sealed: randomBytes(48), activated_at: new Date() }).execute();
    });
    for (const gate of SOFT_LAUNCH_GATES) await a.cmd(p.owner, (trx, ctx) => launchGates.check(trx, ctx, hubC, gate, evidence()));
    assert.deepEqual(await a.as(p.owner, (trx) => hubs.blockers(trx, hubC, 'soft_launch')), []);

    // Still a second person: no approval, a self-approval, a stale revision.
    await rejects(transition(p.owner, hubC, 'soft_launch'), '42501', 'admin.approval_required');
    const stale = await approveTransition(p.owner, p.officer, hubC, 'soft_launch');
    await a.cmd(p.owner, (trx, ctx) => hubs.updateProfile(trx, ctx, hubC, 1, { name: { en: 'Synthetic launch rehearsal hub' }, defaultLocale: 'en', locales: ['en'], timeZone: 'Asia/Tbilisi', currency: 'GEL', brandOverlay: null }));
    // The hub moves on (back to draft and to preparing again): the approval of the earlier state no longer fits.
    await transition(p.owner, hubC, 'draft');
    await transition(p.owner, hubC, 'preparing');
    await rejects(transition(p.owner, hubC, 'soft_launch', stale), '23514', 'admin.approval_mismatch');
    const approval = await approveTransition(p.owner, p.officer, hubC, 'soft_launch');
    await transition(p.owner, hubC, 'soft_launch', approval);
    assert.equal((await hubRow(hubC)).lifecycle, 'soft_launch');
    const audit = (await db.admin.query("SELECT actor_person_id, second_approver_person_id FROM trustwork.admin_audit_event WHERE action = 'hub.lifecycle_changed' AND object_id = $1 ORDER BY sequence DESC LIMIT 1", [hubC])).rows[0];
    assert.deepEqual(audit, { actor_person_id: p.owner, second_approver_person_id: p.officer });

    // Public needs every gate.
    const publicBlockers = await a.as(p.owner, (trx) => hubs.blockers(trx, hubC, 'public'));
    assert.deepEqual(publicBlockers.sort(), LAUNCH_GATES.filter((g) => !SOFT_LAUNCH_GATES.includes(g)).map((g) => `gate:${g}`).sort());
    await rejects(transition(p.owner, hubC, 'public', await approveTransition(p.owner, p.officer, hubC, 'public')), '23514', 'hubs.launch_gate_open');
    for (const domain of ['editorial', 'sources', 'verification', 'screening'] as const) await activate(p.owner, await draft(p.owner, hubC, domain, { policy: 'synthetic' }));
    for (const gate of LAUNCH_GATES.filter((g) => !SOFT_LAUNCH_GATES.includes(g))) await a.cmd(p.owner, (trx, ctx) => launchGates.check(trx, ctx, hubC, gate, evidence()));
    await transition(p.owner, hubC, 'public', await approveTransition(p.owner, p.officer, hubC, 'public'));
    assert.equal((await hubRow(hubC)).lifecycle, 'public');

    // A later change re-opens the gate it rests on; a suspended hub returns to public only when it is checked again.
    await activateSensitive(p.owner, p.officer, await draft(p.owner, hubC, 'residency', { hostingCountry: 'US', hostingRegion: null, personalDataCountries: ['US'], note: 'Synthetic second residency version' }));
    assert.equal((await db.admin.query("SELECT state FROM trustwork.launch_gate WHERE hub_id = $1 AND gate = 'data_residency_configured'", [hubC])).rows[0].state, 'invalidated');
    await transition(p.owner, hubC, 'suspended');
    const back = await rejects(transition(p.owner, hubC, 'public', await approveTransition(p.owner, p.officer, hubC, 'public')), '23514', 'hubs.launch_gate_open');
    assert.equal(back.detail, 'gate:data_residency_configured');
    await a.cmd(p.owner, (trx, ctx) => launchGates.check(trx, ctx, hubC, 'data_residency_configured', evidence()));
    await transition(p.owner, hubC, 'public', await approveTransition(p.owner, p.officer, hubC, 'public'));
    // A gate whose precondition stopped holding blocks even when it is still marked passed.
    await withMaintenance(db.admin, (trx) => trx.updateTable('second_factor').set({ state: 'revoked', revoked_at: new Date(), revoked_reason: 'removed' }).where('person_id', '=', p.officer).execute());
    assert.ok((await a.as(p.owner, (trx) => hubs.blockers(trx, hubC, 'public'))).includes('gate:two_staff_with_second_factor'));
  });

  await t.test('legal acceptance: participants accept active texts of launched hubs and see only their own acceptances', async () => {
    const active = (await db.admin.query("SELECT id FROM trustwork.legal_document_version WHERE hub_id = $1 AND kind = 'terms' AND status = 'active'", [hubC])).rows[0].id as string;
    const accepted = await a.as(p.outsider, (trx) => legalDocuments.accept(trx, active, 'signup'));
    assert.equal(accepted.person_id, p.outsider);
    assert.equal((await a.as(p.outsider, (trx) => legalDocuments.accept(trx, active, 'signup'))).id, accepted.id, 'accepting twice keeps one proof');
    assert.equal((await a.as(p.outsider, (trx) => legalDocuments.acceptances(trx))).length, 1);
    assert.equal((await a.as(p.moderator, (trx) => legalDocuments.acceptances(trx))).length, 0);
    const draftDoc = await a.cmd(p.owner, (trx, ctx) => legalDocuments.draft(trx, ctx, hubC, { kind: 'cookie_notice', locale: 'en', body: 'Synthetic cookie notice' }));
    await rejects(a.as(p.outsider, (trx) => legalDocuments.accept(trx, draftDoc.id, 'signup')), 'P0002', 'admin.not_found');
    assert.equal((await a.as(p.outsider, (trx) => legalDocuments.list(trx, hubC))).every((d) => d.status === 'active'), true, 'participants see active texts only');
    await rejects(withMaintenance(db.admin, (trx) => trx.deleteFrom('legal_acceptance').execute()), '23000', 'audit.append_only');
  });

  await t.test('provider credential references: never a secret value; a non-fake provider needs a second person; rotation retires the previous one', async () => {
    for (const ref of ['sk-live-0123456789abcdef', 'AKIAABCDEFGHIJKLMNOP', 'x'.repeat(60)]) {
      await rejects(a.cmd(p.owner, (trx, ctx) => providerCredentials.register(trx, ctx, hubC, { provider: 'payments', adapter: 'stripe', mode: 'live', secretStore: 'env', secretRef: ref })), '23514');
    }
    const fake = await a.cmd(p.owner, (trx, ctx) => providerCredentials.register(trx, ctx, hubC, { provider: 'payments', adapter: 'fake', mode: 'fake', secretStore: 'env', secretRef: 'PAYMENTS_FAKE' }));
    assert.equal((await a.cmd(p.owner, (trx, ctx) => providerCredentials.activate(trx, ctx, fake.id, null))).status, 'active', 'the fake adapter needs one person');
    const live = await a.cmd(p.owner, (trx, ctx) => providerCredentials.register(trx, ctx, hubC, { provider: 'payments', adapter: 'stripe', mode: 'live', secretStore: 'external_vault', secretRef: 'hubs/synthetic/payments' }));
    await rejects(a.cmd(p.owner, (trx, ctx) => providerCredentials.activate(trx, ctx, live.id, null)), '42501', 'admin.approval_required');
    const approval = await a.approve(p.owner, p.officer, 'providers.enable_non_fake', hubC, credentialActivationDigestInput({ id: live.id, hubId: hubC, provider: 'payments', adapter: 'stripe', mode: 'live', secretStore: 'external_vault', secretRef: 'hubs/synthetic/payments' }));
    const activated = await a.cmd(p.owner, (trx, ctx) => providerCredentials.activate(trx, ctx, live.id, approval));
    assert.equal(activated.rotated_from_id, fake.id);
    assert.equal((await db.admin.query('SELECT status FROM trustwork.provider_credential_ref WHERE id = $1', [fake.id])).rows[0].status, 'retired');
    assert.equal((await a.as(p.otherOwner, (trx) => providerCredentials.list(trx, hubC))).length, 0, 'other hubs never see references');
  });

  await t.test('the module stores no secret values and every hub mutation is audited at its hub', async () => {
    const { rows } = await db.admin.query<{ table_name: string; column_name: string }>("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'trustwork' AND table_name = ANY ($1)", [Object.keys(TABLE_COLUMNS)]);
    for (const r of rows) assert.doesNotMatch(r.column_name, /(secret_value|password|token$|api_key|private_key)/, `${r.table_name}.${r.column_name}`);
    const unaudited = await count(`SELECT v.id FROM trustwork.hub_config_version v WHERE NOT EXISTS (SELECT 1 FROM trustwork.admin_audit_event e WHERE e.object_id = v.id AND e.action = 'hub.config_drafted' AND e.hub_id = v.hub_id)`);
    assert.equal(unaudited, 0);
    assert.equal(await count("SELECT 1 FROM trustwork.admin_audit_event WHERE action LIKE 'hub.%' AND action <> 'hub.created' AND scope_kind <> 'hub'"), 0);
  });
});
