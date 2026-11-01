import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool, withMaintenance, type DataPool, type Transaction } from '@trustwork/data';
import { computeDigest, MODEL_JOBS, PROVIDER_CAPABILITIES } from '@trustwork/contracts';
import { DataClassSchema } from '../../packages/contracts/src/retrieval.js';
import {
  connectionEnableDigestInput, egressAllowDigestInput, isMovingAlias, providerKillReleaseDigestInput, routeActivationDigestInput, type RouteScope,
} from '../../packages/contracts/src/providers.js';
import { approvals, type CommandContext } from '../../packages/data/src/repositories/admin.js';
import {
  egressRules, modelPricing, modelRoutes, providerBudgets, providerCalls, providerChanges, providerConnections, providerKills, providerSweeps, type ConnectionInput, type RouteInput,
} from '../../packages/data/src/repositories/providers.js';
import type { ModelRouteRow, ProviderConnectionRow } from '../../packages/data/src/schema/providers.js';
import { TABLE_COLUMNS } from '../../packages/data/src/schema/providers.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { activateResidency, actors, buildProvidersWorld, rejects, SELF_US, setUpHubs, syncKernel, VENDOR_US } from './helpers.js';

// Weight 2: the runtime pool races concurrent paid authorizations against one cap.
const db = await provisionTestDatabase('providers_core', { weight: 2 });

const sealed = () => ({ fingerprint: randomBytes(6).toString('hex'), ciphertext: randomBytes(48), iv: randomBytes(12), authTag: randomBytes(16), wrappedKey: randomBytes(60), kekId: 'test:kek-synthetic' });
const PROBE = 'a'.repeat(64);

/**
 * KEYS-001 on real PostgreSQL under the runtime role: connections with restricted-place refusal, sealed secrets that no
 * runtime role can read, synthetic connection tests, second-person enabling, the egress matrix, routes scoped by job,
 * module and extension, the call gate with fallbacks, kill switches and caps (also under concurrency), and cost records
 * that leave every sale price unchanged. Every refusal is the database's own; every person and hub is synthetic.
 */
test('providers: connections, secrets, egress, routes, caps, kill switches and cost records', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const runtime: DataPool = createPool({ ...db.appConfig, max: 12 });
  t.after(async () => { await runtime.end(); await db.close(); });
  await syncKernel(db.admin);
  const w = await buildProvidersWorld(db.admin);
  const a = actors(db.admin, runtime, w);
  const p = w.people;
  const { hubA, hubB } = await setUpHubs(a, w, 'synthetic-providers');
  await activateResidency(a, p.owner, p.officer, hubA, ['US']);
  const q = async <T>(text: string, params: unknown[] = []) => (await db.admin.query<T & Record<string, unknown>>(text, params)).rows;

  const base: ConnectionInput = { label: 'Synthetic US model server', capabilities: ['llm'], endpoint: 'https://models.synthetic.example/v1', hosting: VENDOR_US, storageCountry: null, region: 'us-east-1', credentialRefId: null };
  const create = (personId: string, hubId: string, over: Partial<ConnectionInput & { adapterId: string; mode: string }> = {}) =>
    a.cmd(personId, (trx, ctx) => providerConnections.create(trx, ctx, hubId, { adapterId: 'openai_compatible', mode: 'live', ...base, ...over }));
  const fresh = async (id: string) => (await q<ProviderConnectionRow>('SELECT * FROM trustwork.provider_connection WHERE id = $1', [id]))[0]!;
  const recordTest = async (personId: string, id: string, outcome = 'ok') => {
    const material = await a.cmd(personId, (trx, ctx) => providerConnections.testMaterial(trx, ctx, id));
    return a.cmd(personId, (trx, ctx) => providerConnections.recordTest(trx, ctx, id, { configDigest: material.config_digest, outcome, latencyMs: 12, modelsListed: 3, cost: null, probeDigest: PROBE, secretRefId: material.secret_ref_id }));
  };
  const approveDigest = async (requester: string, approver: string, action: string, hubId: string, digest: string): Promise<string> => {
    const request = await a.cmd(requester, (trx, ctx) => approvals.request(trx, ctx, { action, scope: { kind: 'hub', hubId }, actionDigest: digest }));
    await a.cmd(approver, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    return request.id;
  };
  const sqlDigest = async (fn: string, id: string) => (await q<{ d: string }>(`SELECT trustwork.${fn}($1) AS d`, [id]))[0]!.d;
  /** Enables a live connection: test, secret (vendor), the officer approves the owner's request. */
  const enableLive = async (row: ProviderConnectionRow): Promise<ProviderConnectionRow> => {
    if (row.hosting_kind === 'vendor') await a.cmd(p.owner, (trx, ctx) => providerConnections.storeSecret(trx, ctx, row.id, row.revision, sealed(), 24));
    await recordTest(p.owner, row.id);
    const current = await fresh(row.id);
    const approval = await approveDigest(p.owner, p.officer, 'providers.enable_non_fake', current.hub_id, await sqlDigest('providers_connection_digest', row.id));
    return a.cmd(p.owner, (trx, ctx) => providerConnections.enable(trx, ctx, row.id, current.revision, approval));
  };
  const allow = async (connectionId: string, hubId: string, dataClass: string) => {
    if (dataClass === 'public') return a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId, dataClass, decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null }));
    const version = await a.as(p.owner, (trx) => egressRules.nextVersion(trx, connectionId, dataClass));
    const approval = await approveDigest(p.owner, p.officer, 'egress.allow_private_class', hubId, computeDigest(egressAllowDigestInput({ hubId, connectionId, dataClass, requireInResidency: true, requireZeroRetention: true, version })).value);
    return a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId, dataClass, decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: approval }));
  };
  const limits = { maxInputTokens: 8000, maxOutputTokens: 1000, maxFileBytes: null, timeoutMs: 30_000 };
  const draftRoute = (personId: string, hubId: string, input: Partial<RouteInput> & Pick<RouteInput, 'primary'>) =>
    a.cmd(personId, (trx, ctx) => modelRoutes.draft(trx, ctx, hubId, { job: 'agent_drafting', scope: { kind: 'job' }, fallbacks: [], allowedDataClasses: ['public'], limits, budgetId: null, ...input }));
  const activateRoute = async (route: ModelRouteRow, drafter = p.owner, activator = p.officer): Promise<ModelRouteRow> => {
    const priv = route.allowed_data_classes.some((c) => c !== 'public');
    const approval = priv ? await approveDigest(activator, drafter, 'models.activate_private_route', route.hub_id, await sqlDigest('providers_route_digest', route.id)) : null;
    return a.cmd(priv ? activator : drafter, (trx, ctx) => modelRoutes.activate(trx, ctx, route.id, route.revision, approval));
  };
  const call = (hubId: string, over: Record<string, unknown> = {}) => providerCalls.authorize(runtime, {
    hubId, job: 'agent_drafting', moduleKey: null, extensionId: null, pipelineId: null, dataClasses: ['public'], estimatedCost: { minorUnits: '10', currency: 'USD' }, requestRef: `run-${randomUUID()}`, ...over,
  });

  await t.test('vocabularies and digests match the contracts', async () => {
    assert.deepEqual((await q<{ v: string[] }>('SELECT trustwork.providers_capabilities() AS v'))[0]!.v, [...PROVIDER_CAPABILITIES]);
    assert.deepEqual((await q<{ v: string[] }>('SELECT trustwork.providers_model_jobs() AS v'))[0]!.v, [...MODEL_JOBS]);
    assert.deepEqual((await q<{ v: string[] }>('SELECT trustwork.providers_data_classes() AS v'))[0]!.v, [...DataClassSchema.options]);
    for (const r of ['latest', 'gpt-x-latest', 'm@stable', '2026-09-01', 'rev-7', 'Preview', 'model-current']) {
      assert.equal((await q<{ v: boolean }>('SELECT trustwork.providers_moving_alias($1) AS v', [r]))[0]!.v, isMovingAlias(r), r);
    }
    const hubId = randomUUID();
    const connectionId = randomUUID();
    assert.equal((await q<{ d: string }>('SELECT trustwork.providers_egress_digest($1, $2, $3, true, true, 4) AS d', [hubId, connectionId, 'person_private']))[0]!.d,
      computeDigest(egressAllowDigestInput({ hubId, connectionId, dataClass: 'person_private', requireInResidency: true, requireZeroRetention: true, version: 4 })).value);
    const killId = randomUUID();
    assert.equal((await q<{ d: string }>('SELECT trustwork.admin_kill_switch_release_digest($1, $2) AS d', [killId, 'Synthetic incident note']))[0]!.d,
      computeDigest(providerKillReleaseDigestInput({ killSwitchId: killId, incidentNote: 'Synthetic incident note' })).value);
    assert.ok(TABLE_COLUMNS.secret_version.includes('ciphertext'));
  });

  await t.test('negative: restricted places are refused at save time, and only the hub\'s staff with the permission connect', async () => {
    const refused = await rejects(create(p.owner, hubA, { hosting: { ...VENDOR_US, country: 'IR' } }), '23514', 'providers.restricted_place');
    assert.equal(refused.detail, 'IR');
    await rejects(create(p.owner, hubA, { storageCountry: 'RU' }), '23514', 'providers.restricted_place');
    await rejects(create(p.owner, hubA, { hosting: { kind: 'self_hosted', country: 'KP' } }), '23514', 'providers.restricted_place');
    await rejects(create(p.moderator, hubA), '42501', 'admin.forbidden');
    await rejects(create(p.otherOwner, hubA), '42501', 'admin.forbidden');
    await rejects(create(p.owner, hubB), '42501', 'admin.forbidden');
    await rejects(create(p.owner, hubA, { endpoint: 'http://models.synthetic.example/v1' }), '23514', 'providers.endpoint_not_allowed');
    await rejects(create(p.owner, hubA, { endpoint: 'https://10.0.0.8/v1' }), '23514', 'providers.endpoint_not_allowed');
    const ok = await create(p.owner, hubA);
    await rejects(a.cmd(p.owner, (trx, ctx) => providerConnections.update(trx, ctx, ok.id, ok.revision, { ...base, hosting: { ...VENDOR_US, country: 'CU' } })), '23514', 'providers.restricted_place');
    assert.equal(await count(db.admin, "SELECT 1 FROM trustwork.provider_connection WHERE processing_country IN ('IR', 'RU', 'KP', 'CU') OR storage_country IN ('IR', 'RU', 'KP', 'CU')"), 0);
    // Staff of another hub and participants see nothing.
    assert.equal((await a.as(p.otherOwner, (trx) => providerConnections.list(trx, hubA))).length, 0);
    assert.equal((await a.as(p.moderator, (trx) => providerConnections.list(trx, hubA))).length, 0);
    assert.equal((await a.as(p.outsider, (trx) => providerConnections.list(trx, hubA))).length, 0);
  });

  await t.test('secrets: ciphertext only, unreadable by the runtime role; rotation keeps a grace version; revocation destroys every version', async () => {
    const conn = await create(p.owner, hubA, { label: 'Synthetic rotation server' });
    await rejects(a.cmd(p.moderator, (trx, ctx) => providerConnections.storeSecret(trx, ctx, conn.id, conn.revision, sealed(), 24)), '42501', 'admin.forbidden');
    const v1 = await a.cmd(p.owner, (trx, ctx) => providerConnections.storeSecret(trx, ctx, conn.id, conn.revision, sealed(), 24));
    assert.equal(v1.ref, `connection:${conn.id}:v1`);
    assert.match(v1.keyed_fingerprint, /^[a-f0-9]{12}$/);
    // No runtime role can read ciphertext, whatever its staff role.
    await rejects(a.as(p.owner, (trx) => trx.selectFrom('secret_version').selectAll().execute()), '42501');
    // A stale revision is refused; fake connections never hold secrets.
    await rejects(a.cmd(p.owner, (trx, ctx) => providerConnections.storeSecret(trx, ctx, conn.id, conn.revision, sealed(), 24)), '23514', 'providers.revision_conflict');
    const fake = await create(p.owner, hubA, { adapterId: 'fake', mode: 'fake', label: 'Synthetic fake model', endpoint: null });
    await rejects(a.cmd(p.owner, (trx, ctx) => providerConnections.storeSecret(trx, ctx, fake.id, fake.revision, sealed(), 24)), '23514', 'providers.fake_holds_no_secret');

    const v2 = await a.cmd(p.owner, async (trx, ctx) => providerConnections.storeSecret(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, sealed(), 1));
    const refs = await a.as(p.owner, (trx) => providerConnections.secretRefs(trx, hubA));
    const mine = refs.filter((r) => r.connection_id === conn.id);
    assert.deepEqual(mine.map((r) => [r.version, r.status]), [[2, 'active'], [1, 'grace']]);
    assert.equal(v2.version, 2);
    // The worker destroys the grace version once its grace has passed (moved into the past here).
    assert.equal(await providerSweeps.destroyExpiredSecrets(db.admin), 0);
    await withMaintenance(db.admin, (trx) => trx.updateTable('secret_ref').set({ grace_until: new Date(Date.now() - 1000) }).where('id', '=', v1.id).execute());
    assert.equal(await providerSweeps.destroyExpiredSecrets(db.admin), 1);
    assert.equal(await count(db.admin, 'SELECT 1 FROM trustwork.secret_version WHERE secret_ref_id = $1', [v1.id]), 0, 'the ciphertext is gone');
    const revoked = await a.cmd(p.owner, async (trx, ctx) => providerConnections.revokeSecret(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision));
    assert.equal(revoked.status, 'draft');
    assert.equal(await count(db.admin, 'SELECT 1 FROM trustwork.secret_version v JOIN trustwork.secret_ref r ON r.id = v.secret_ref_id WHERE r.connection_id = $1', [conn.id]), 0);
    assert.deepEqual((await q<{ status: string }>('SELECT DISTINCT status FROM trustwork.secret_ref WHERE connection_id = $1', [conn.id])).map((r) => r.status), ['destroyed']);
    // The change log records versions and fingerprints, never ciphertext.
    const changes = await a.as(p.owner, (trx) => providerChanges.list(trx, hubA, { objectType: 'secret_ref' }));
    assert.ok(changes.some((c) => c.action === 'providers.secret_written' && (c.after as { keyed_fingerprint?: string }).keyed_fingerprint === v1.keyed_fingerprint));
    assert.ok(changes.some((c) => c.action === 'providers.secret_grace_ended' && c.actor_person_id === null));
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('provider_config_change').values({ hub_id: hubA, object_type: 'secret_ref', object_id: v1.id, action: 'providers.secret_written',
      actor_person_id: p.owner, reason: 'Synthetic', after: { ciphertext: 'x' } }).execute()), '23514');
  });

  await t.test('connection tests and enabling: a passing test of the current configuration, a secret for live vendors, and a second person', async () => {
    const conn = await create(p.owner, hubA, { label: 'Synthetic enable server' });
    await rejects(a.cmd(p.owner, (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, conn.revision, null)), '23514', 'providers.test_required');
    await recordTest(p.owner, conn.id, 'auth_failed');
    await rejects(a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, null)), '23514', 'providers.test_failed');
    await recordTest(p.owner, conn.id);
    await rejects(a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, null)), '23514', 'providers.secret_required');
    await a.cmd(p.owner, async (trx, ctx) => providerConnections.storeSecret(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, sealed(), 24));
    await rejects(a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, null)), '23514', 'providers.test_required');
    await recordTest(p.owner, conn.id);
    const tested = await fresh(conn.id);
    await rejects(a.cmd(p.owner, (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, tested.revision, null)), '42501', 'admin.approval_required');
    // The SQL digest is the contract's digest.
    const secret = (await q<{ keyed_fingerprint: string }>("SELECT keyed_fingerprint FROM trustwork.secret_ref WHERE connection_id = $1 AND status = 'active'", [conn.id]))[0]!;
    assert.equal(await sqlDigest('providers_connection_digest', conn.id), computeDigest(connectionEnableDigestInput({
      id: conn.id, hubId: hubA, adapterId: 'openai_compatible', mode: 'live', endpoint: base.endpoint, hosting: VENDOR_US, storageCountry: null, secretFingerprint: secret.keyed_fingerprint,
      credentialRefId: null, testId: tested.last_test_id!, revision: tested.revision,
    })).value);
    // Nobody approves their own request.
    const digest = await sqlDigest('providers_connection_digest', conn.id);
    const own = await a.cmd(p.owner, (trx, ctx) => approvals.request(trx, ctx, { action: 'providers.enable_non_fake', scope: { kind: 'hub', hubId: hubA }, actionDigest: digest }));
    await rejects(a.cmd(p.owner, (trx, ctx) => approvals.decide(trx, ctx, own.id, 'approve', digest)), '42501', 'admin.self_approval');
    // An approval bound to an older configuration does not enable a changed one.
    await a.cmd(p.officer, (trx, ctx) => approvals.decide(trx, ctx, own.id, 'approve', digest));
    await a.cmd(p.owner, (trx, ctx) => providerConnections.update(trx, ctx, conn.id, tested.revision, { ...base, label: 'Synthetic enable server (renamed)' }));
    await rejects(a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, conn.id, (await providerConnections.get(trx, conn.id))!.revision, own.id)), '23514', 'admin.approval_mismatch');
    // A fresh secret version, a test of exactly that configuration and a new approval of its digest.
    const enabled = await enableLive(await fresh(conn.id));
    assert.equal(enabled.status, 'enabled');
    assert.equal(enabled.enabled_by, p.owner);
    // Changing where data goes returns it to draft.
    const moved = await a.cmd(p.owner, (trx, ctx) => providerConnections.update(trx, ctx, conn.id, enabled.revision, { ...base, endpoint: 'https://other.synthetic.example/v1' }));
    assert.equal(moved.status, 'draft');
    // A fake connection is enabled by one person after its test.
    const fake = await create(p.owner, hubA, { adapterId: 'fake', mode: 'fake', label: 'Synthetic fake for enabling', endpoint: null });
    await recordTest(p.owner, fake.id);
    const fakeOn = await a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, fake.id, (await providerConnections.get(trx, fake.id))!.revision, null));
    assert.equal(fakeOn.status, 'enabled');
    const audit = await q<{ action: string; second_approver_person_id: string | null }>("SELECT action, second_approver_person_id FROM trustwork.admin_audit_event WHERE object_id = $1 AND action = 'providers.connection_enabled'", [conn.id]);
    assert.equal(audit[0]?.second_approver_person_id, p.officer);
  });

  // A shared fixture for the gate: three enabled connections of hub A.
  const fakeConn = await create(p.owner, hubA, { adapterId: 'fake', mode: 'fake', label: 'Synthetic gate fake', endpoint: null });
  await recordTest(p.owner, fakeConn.id);
  await a.cmd(p.owner, async (trx, ctx) => providerConnections.enable(trx, ctx, fakeConn.id, (await providerConnections.get(trx, fakeConn.id))!.revision, null));
  const vendor = await enableLive(await create(p.owner, hubA, { label: 'Synthetic gate vendor' }));
  const local = await enableLive(await create(p.owner, hubA, { label: 'Synthetic gate local server', hosting: SELF_US, endpoint: 'http://127.0.0.1:11434/v1', adapterId: 'openai_compatible' }));
  const trains = await enableLive(await create(p.owner, hubA, { label: 'Synthetic training vendor', hosting: { ...VENDOR_US, trainsOnInputs: true } }));
  const broker = await enableLive(await create(p.owner, hubA, { label: 'Synthetic broker', hosting: { ...VENDOR_US, broker: true } }));
  const abroad = await enableLive(await create(p.owner, hubA, { label: 'Synthetic vendor abroad', hosting: { ...VENDOR_US, country: 'DE' } }));
  const ref = (c: { id: string }, model = 'model-a', revision: string | null = 'rev-2026-09') => ({ connectionId: c.id, modelId: model, modelRevision: revision });

  await t.test('egress: default deny; a non-public allow needs a second person and is refused for training, brokers, residency', async () => {
    await allow(vendor.id, hubA, 'public');
    await rejects(a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: vendor.id, dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: null })), '42501', 'admin.approval_required');
    await rejects(a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: vendor.id, dataClass: 'person_private', decision: 'allow', requireInResidency: false, requireZeroRetention: true, approvalId: null })), '23514', 'providers.egress_not_in_residency');
    await rejects(a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: trains.id, dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: null })), '23514', 'providers.egress_training');
    await rejects(a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: broker.id, dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: null })), '23514', 'providers.egress_broker');
    await rejects(a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: abroad.id, dataClass: 'person_private', decision: 'allow', requireInResidency: true, requireZeroRetention: true, approvalId: null })), '23514', 'providers.egress_not_in_residency');
    await rejects(a.cmd(p.moderator, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: vendor.id, dataClass: 'public', decision: 'allow', requireInResidency: false, requireZeroRetention: false, approvalId: null })), '42501', 'admin.forbidden');
    const cell = await allow(local.id, hubA, 'person_private');
    assert.equal(cell.decision, 'allow');
    assert.ok(cell.approval_id);
    await allow(local.id, hubA, 'public');
    // Narrowing is one person.
    const deny = await a.cmd(p.owner, (trx, ctx) => egressRules.set(trx, ctx, { connectionId: vendor.id, dataClass: 'company_private', decision: 'deny', requireInResidency: true, requireZeroRetention: true, approvalId: null }));
    assert.equal(deny.version, 1);
    // A direct write without the approval is refused by the table itself (even for the owner role).
    await rejects(withMaintenance(db.admin, (trx) => trx.insertInto('egress_rule').values({ hub_id: hubA, connection_id: vendor.id, data_class: 'person_private', decision: 'allow',
      require_in_residency: true, require_zero_retention: true, version: 99, approval_id: null, reason: 'Synthetic', created_by: p.owner }).execute()), '42501', 'admin.approval_required');
  });

  let jobRoute: ModelRouteRow;
  await t.test('routes: pinned revisions on enabled connections; the drafter alone never activates a non-public route', async () => {
    const unpinned = await draftRoute(p.owner, hubA, { primary: ref(vendor, 'model-a', null) });
    await rejects(a.cmd(p.owner, (trx, ctx) => modelRoutes.activate(trx, ctx, unpinned.id, unpinned.revision, null)), '23514', 'providers.route_unpinned');
    await rejects(draftRoute(p.owner, hubA, { primary: ref(vendor, 'model-a', 'latest') }), '23514');
    await rejects(draftRoute(p.owner, hubA, { job: 'embeddings', primary: ref(local), fallbacks: [ref(vendor)] }), '23514', 'providers.route_fallbacks_forbidden');
    await rejects(draftRoute(p.owner, hubA, { job: 'image_generation', primary: ref(vendor), allowedDataClasses: ['public', 'person_private'] }), '23514', 'providers.route_public_only');
    await rejects(draftRoute(p.owner, hubB, { primary: ref(vendor) }), '42501', 'admin.forbidden');
    await rejects(draftRoute(p.owner, hubA, { primary: { connectionId: randomUUID(), modelId: 'x', modelRevision: 'r' } }), '23514', 'providers.route_connection_unusable');

    const priv = await draftRoute(p.owner, hubA, { primary: ref(local), fallbacks: [ref(vendor, 'model-b')], allowedDataClasses: ['public', 'person_private'] });
    // The drafter alone: refused, with or without an approval.
    await rejects(a.cmd(p.owner, (trx, ctx) => modelRoutes.activate(trx, ctx, priv.id, priv.revision, null)), '42501', 'providers.drafter_cannot_activate');
    await rejects(a.cmd(p.officer, (trx, ctx) => modelRoutes.activate(trx, ctx, priv.id, priv.revision, null)), '42501', 'admin.approval_required');
    // The SQL digest is the contract's digest.
    assert.equal(await sqlDigest('providers_route_digest', priv.id), computeDigest(routeActivationDigestInput({
      id: priv.id, hubId: hubA, job: 'agent_drafting', scope: { kind: 'job' }, version: priv.version, primary: ref(local), fallbacks: [ref(vendor, 'model-b')],
      allowedDataClasses: ['public', 'person_private'], limits, budgetId: null,
    })).value);
    // Outside residency for a non-public route: refused before any approval is consumed.
    const far = await draftRoute(p.owner, hubA, { scope: { kind: 'module', moduleKey: 'research' }, primary: ref(abroad), allowedDataClasses: ['public', 'person_private'] });
    await rejects(activateRoute(far), '23514', 'providers.route_outside_residency');
    jobRoute = await activateRoute(priv);
    assert.equal(jobRoute.status, 'active');
    assert.equal(jobRoute.activated_by, p.officer);
    // A public-only route is activated by one person, and supersedes the previous active version of its scope.
    const pub = await draftRoute(p.owner, hubA, { primary: ref(vendor), fallbacks: [ref(fakeConn, 'fake-model')] });
    const next = await activateRoute(pub);
    assert.equal(next.activated_by, p.owner);
    assert.equal((await fresh2(priv.id)).status, 'superseded');
    jobRoute = await activateRoute(await draftRoute(p.owner, hubA, { primary: ref(local), fallbacks: [ref(vendor, 'model-b')], allowedDataClasses: ['public', 'person_private'] }));
    // A route on a draft connection cannot be activated.
    const draftConn = await create(p.owner, hubA, { label: 'Synthetic never enabled' });
    await rejects(activateRoute(await draftRoute(p.owner, hubA, { scope: { kind: 'module', moduleKey: 'negotiator' }, primary: ref(draftConn) })), '23514', 'providers.route_connection_unusable');
  });
  async function fresh2(id: string) { return (await q<ModelRouteRow>('SELECT * FROM trustwork.model_route WHERE id = $1', [id]))[0]!; }

  await t.test('the call gate: extension, then module, then job; no active route refuses; egress per data class; fallbacks only for availability', async () => {
    assert.deepEqual(await call(hubA, { job: 'translation' }), { allowed: false, reason: 'no_active_route', detail: null });
    assert.deepEqual(await call(hubB), { allowed: false, reason: 'no_active_route', detail: null }, 'another hub has no route');
    const modRoute = await activateRoute(await draftRoute(p.owner, hubA, { scope: { kind: 'module', moduleKey: 'negotiator' }, primary: ref(vendor, 'model-mod') }));
    const extId = randomUUID();
    const extRoute = await activateRoute(await draftRoute(p.owner, hubA, { scope: { kind: 'extension', extensionId: extId }, primary: ref(vendor, 'model-ext') }));
    const pick = async (moduleKey: string | null, extensionId: string | null) => (await call(hubA, { moduleKey, extensionId })) as { allowed: boolean; routeId?: string };
    assert.equal((await pick('negotiator', extId)).routeId, extRoute.id, 'extension first');
    assert.equal((await pick('negotiator', randomUUID())).routeId, modRoute.id, 'then module');
    assert.equal((await pick('research', null)).routeId, jobRoute.id, 'then job');

    // A non-public class to a connection without an allow cell is refused (the module route's vendor has no cell).
    assert.deepEqual(await call(hubA, { moduleKey: 'negotiator', dataClasses: ['person_private'] }), { allowed: false, reason: 'data_class_not_in_route', detail: 'person_private' });
    const vendorPriv = await activateRoute(await draftRoute(p.owner, hubA, { job: 'summarisation', primary: ref(vendor, 'model-sum'), allowedDataClasses: ['public', 'company_private'] }));
    assert.deepEqual(await call(hubA, { job: 'summarisation', dataClasses: ['company_private'] }), { allowed: false, reason: 'egress_denied', detail: 'denied' });
    assert.equal((await call(hubA, { job: 'summarisation', dataClasses: ['public'] }) as { allowed: boolean; routeId: string }).routeId, vendorPriv.id);
    const quiet = await activateRoute(await draftRoute(p.owner, hubA, { job: 'classification', primary: ref(local, 'model-cls'), allowedDataClasses: ['public', 'deal_party_private'] }));
    assert.deepEqual(await call(hubA, { job: 'classification', dataClasses: ['deal_party_private'] }), { allowed: false, reason: 'egress_denied', detail: 'no_rule' });
    void quiet;

    // The job route: private data to the local server (allowed); the vendor fallback has no private cell, so it is not a candidate.
    const priv = await call(hubA, { dataClasses: ['person_private'] }) as { allowed: true; candidates: { connectionId: string }[]; decisionId: string };
    assert.equal(priv.allowed, true);
    assert.deepEqual(priv.candidates.map((c) => c.connectionId), [local.id]);
    const pub = await call(hubA) as { allowed: true; candidates: { connectionId: string }[] };
    assert.deepEqual(pub.candidates.map((c) => c.connectionId), [local.id, vendor.id], 'public data may fall back to the vendor');

    // Killing the primary connection: public calls fall back, private calls stop (the fallback is not allowed for them).
    const kill = await a.cmd(p.owner, (trx, ctx) => providerKills.engage(trx, ctx, hubA, { kind: 'connection', connectionId: local.id }));
    assert.equal(kill.kind, 'connection');
    assert.deepEqual((await call(hubA) as { candidates: { connectionId: string }[] }).candidates.map((c) => c.connectionId), [vendor.id]);
    assert.deepEqual(await call(hubA, { dataClasses: ['person_private'] }), { allowed: false, reason: 'no_available_connection', detail: null });
    // Release: a second person and an incident note.
    await rejects(a.cmd(p.owner, (trx, ctx) => providerKills.release(trx, ctx, hubA, kill.id, null, 'Synthetic incident note')), '42501');
    const note = 'Synthetic incident reviewed';
    const releaseApproval = await approveDigest(p.owner, p.officer, 'kill_switch.release', hubA, computeDigest(providerKillReleaseDigestInput({ killSwitchId: kill.id, incidentNote: note })).value);
    await rejects(a.cmd(p.owner, (trx, ctx) => providerKills.release(trx, ctx, hubA, kill.id, releaseApproval, 'A different note')), '23514', 'admin.approval_mismatch');
    await a.cmd(p.owner, (trx, ctx) => providerKills.release(trx, ctx, hubA, kill.id, releaseApproval, note));
    assert.equal((await call(hubA, { dataClasses: ['person_private'] }) as { allowed: boolean }).allowed, true);

    // A route kill switch stops exactly its route; the less specific route does not take over a killed one's calls.
    const routeKill = await a.cmd(p.owner, (trx, ctx) => providerKills.engage(trx, ctx, hubA, { kind: 'route', job: 'agent_drafting', scope: { kind: 'module', moduleKey: 'negotiator' } as RouteScope }));
    assert.equal((await call(hubA, { moduleKey: 'negotiator' }) as { reason: string }).reason, 'route_killed');
    assert.equal((await call(hubA, { moduleKey: 'research' }) as { allowed: boolean }).allowed, true);
    await rejects(a.cmd(p.owner, (trx, ctx) => providerKills.engage(trx, ctx, hubA, { kind: 'route', job: 'agent_drafting', scope: { kind: 'module', moduleKey: 'negotiator' } })), '23514', 'providers.kill_engaged');
    const rNote = 'Synthetic route incident';
    await rejects(a.cmd(p.owner, (trx, ctx) => providerKills.release(trx, ctx, hubA, routeKill.id, null, rNote)), '42501', 'admin.approval_required');
    const rApproval = await approveDigest(p.owner, p.officer, 'kill_switch.release', hubA, computeDigest(providerKillReleaseDigestInput({ killSwitchId: routeKill.id, incidentNote: rNote })).value);
    await a.cmd(p.owner, (trx, ctx) => providerKills.release(trx, ctx, hubA, routeKill.id, rApproval, rNote));
    assert.equal((await call(hubA, { moduleKey: 'negotiator' }) as { allowed: boolean }).allowed, true);
    await rejects(a.cmd(p.moderator, (trx, ctx) => providerKills.engage(trx, ctx, hubA, { kind: 'connection', connectionId: vendor.id })), '42501', 'admin.forbidden');
    const killChanges = await a.as(p.owner, (trx) => providerChanges.list(trx, hubA, { objectType: 'kill_switch' }));
    assert.ok(killChanges.some((c) => c.action === 'providers.kill_engaged' && c.before === null && c.after !== null));
    assert.ok(killChanges.some((c) => c.action === 'kill_switch.release' && (c.before as { state: string }).state === 'engaged' && (c.after as { state: string }).state === 'released'));
  });

  await t.test('caps: an exhausted cap blocks new paid calls, also under concurrency; fake calls are not paid', async () => {
    const capRoute = await activateRoute(await draftRoute(p.owner, hubA, { job: 'fact_check_assist', primary: ref(vendor, 'model-fc') }));
    void capRoute;
    await rejects(a.cmd(p.owner, (trx, ctx) => providerBudgets.create(trx, ctx, hubA, { scope: { kind: 'job', job: 'fact_check_assist' }, period: 'day', limit: { minorUnits: '100', currency: 'EUR' }, alertAtPercent: [50], onExhausted: 'deny_new' })), '23514', 'providers.cap_currency');
    const cap = await a.cmd(p.owner, (trx, ctx) => providerBudgets.create(trx, ctx, hubA, { scope: { kind: 'job', job: 'fact_check_assist' }, period: 'day', limit: { minorUnits: '100', currency: 'USD' }, alertAtPercent: [50, 80], onExhausted: 'deny_new' }));
    const fc = (minor: string) => call(hubA, { job: 'fact_check_assist', estimatedCost: { minorUnits: minor, currency: 'USD' } });
    const first = await fc('60') as { allowed: true; decisionId: string; reserved: { minorUnits: string } };
    assert.equal(first.reserved.minorUnits, '60');
    assert.deepEqual(await fc('41'), { allowed: false, reason: 'cap_exhausted', detail: cap.id }, 'the estimate must fit what is left');
    await providerCalls.settle(runtime, first.decisionId, { connectionId: vendor.id, modelId: 'model-fc', outcome: 'succeeded', costMinorUnits: '100', inputTokens: 900, outputTokens: 100 });
    assert.deepEqual(await fc('0'), { allowed: false, reason: 'cap_exhausted', detail: cap.id }, 'an exhausted cap blocks even a zero estimate');
    const alerts = await q<{ type: string; payload: Record<string, unknown> }>("SELECT type, payload FROM trustwork.outbox_event WHERE type IN ('providers.cap_alert', 'providers.cap_exhausted') AND payload ->> 'budgetId' = $1 ORDER BY id", [cap.id]);
    assert.deepEqual(alerts.map((x) => [x.type, x.payload.percent ?? null]), [['providers.cap_alert', 50], ['providers.cap_alert', 80], ['providers.cap_exhausted', null]]);
    // A fake connection is not paid: it never counts against or is blocked by a cap.
    await activateRoute(await draftRoute(p.owner, hubA, { job: 'entity_resolution_assist', primary: ref(fakeConn, 'fake-model') }));
    assert.deepEqual(await call(hubA, { job: 'entity_resolution_assist' }), { allowed: false, reason: 'egress_denied', detail: 'no_rule' }, 'default deny holds for fakes too');
    await allow(fakeConn.id, hubA, 'public');
    await a.cmd(p.owner, (trx, ctx) => providerBudgets.create(trx, ctx, hubA, { scope: { kind: 'job', job: 'entity_resolution_assist' }, period: 'day', limit: { minorUnits: '0', currency: 'USD' }, alertAtPercent: [], onExhausted: 'deny_new' }));
    assert.equal((await call(hubA, { job: 'entity_resolution_assist' }) as { allowed: boolean }).allowed, true);

    // Concurrency: 12 calls of 10 against a fresh cap of 50; exactly five pass.
    await a.cmd(p.owner, (trx, ctx) => providerBudgets.create(trx, ctx, hubA, { scope: { kind: 'agent_module', moduleKey: 'concurrency' }, period: 'month', limit: { minorUnits: '50', currency: 'USD' }, alertAtPercent: [], onExhausted: 'pause' }));
    const decisions = await Promise.all(Array.from({ length: 12 }, () => call(hubA, { moduleKey: 'concurrency' }) as Promise<{ allowed: boolean; reason?: string }>));
    assert.equal(decisions.filter((d) => d.allowed).length, 5, JSON.stringify(decisions));
    assert.ok(decisions.filter((d) => !d.allowed).every((d) => d.reason === 'cap_exhausted'));
    // Releasing an unsent call frees its reservation.
    const passed = decisions.find((d) => d.allowed) as unknown as { decisionId: string };
    await providerCalls.release(runtime, passed.decisionId);
    assert.equal((await call(hubA, { moduleKey: 'concurrency' }) as { allowed: boolean }).allowed, true);
    // A cap change is audited with before and after values.
    const updated = await a.cmd(p.owner, (trx, ctx) => providerBudgets.update(trx, ctx, cap.id, cap.revision, { limit: { minorUnits: '500', currency: 'USD' }, alertAtPercent: [90], onExhausted: 'pause' }));
    const change = (await a.as(p.owner, (trx) => providerChanges.list(trx, hubA, { objectId: cap.id }))).find((c) => c.action === 'providers.cap_updated')!;
    assert.equal((change.before as { limit_minor: number }).limit_minor, 100);
    assert.equal((change.after as { limit_minor: number }).limit_minor, 500);
    assert.equal(change.actor_person_id, p.owner);
    assert.equal(change.reason, 'Synthetic hub test');
    assert.equal(updated.revision, cap.revision + 1);
    assert.equal((await fc('10') as { allowed: boolean }).allowed, true);
  });

  await t.test('the sealed secret of a call: only for an open decision and one of its candidates', async () => {
    const d = await call(hubA, { moduleKey: 'research' }) as { allowed: true; decisionId: string; candidates: { connectionId: string }[] };
    const material = await providerCalls.secret(runtime, d.decisionId, local.id);
    assert.equal(material.ciphertext, null, 'a self-hosted server without a key has no ciphertext');
    const vendorMaterial = await providerCalls.secret(runtime, d.decisionId, vendor.id);
    assert.ok(vendorMaterial.ciphertext && vendorMaterial.wrapped_key && vendorMaterial.kek_id);
    await rejects(providerCalls.secret(runtime, d.decisionId, trains.id), '42501', 'providers.decision_unknown');
    await rejects(providerCalls.secret(runtime, randomUUID(), vendor.id), '42501', 'providers.decision_unknown');
    await providerCalls.settle(runtime, d.decisionId, { connectionId: local.id, modelId: 'model-a', outcome: 'succeeded', costMinorUnits: '3' });
    await rejects(providerCalls.secret(runtime, d.decisionId, vendor.id), '42501', 'providers.decision_unknown');
    await rejects(providerCalls.settle(runtime, d.decisionId, { connectionId: local.id, modelId: 'model-a', outcome: 'succeeded', costMinorUnits: '3' }), '23514', 'providers.decision_unknown');
  });

  await t.test('cost records: versioned per model; a new record leaves every active sale price unchanged', async () => {
    const offer = await withMaintenance(db.admin, async (trx) => {
      const o = await trx.insertInto('offer').values({ hub_id: hubA, code: 'synthetic_agent_module', name: 'Synthetic agent module', kind: 'agent_module', status: 'active', created_by: p.owner }).returning('id').executeTakeFirstOrThrow();
      // Drafted by one person, activated by another, effective after activation (the billing guard's rules).
      const price = await trx.insertInto('price_version').values({ offer_id: o.id, version: 1, amount_minor: '1000', currency: 'USD', effective_from: new Date(Date.now() + 3_600_000),
        acceptance_text_version: 'v1', drafted_by: p.owner }).returning('id').executeTakeFirstOrThrow();
      await trx.updateTable('price_version').set({ status: 'active', activated_by: p.officer }).where('id', '=', price.id).execute();
      return o.id;
    });
    const snapshot = async () => JSON.stringify(await q('SELECT * FROM trustwork.price_version ORDER BY id')) + JSON.stringify(await q('SELECT * FROM trustwork.meter_rate_version ORDER BY id'))
      + JSON.stringify(await q('SELECT * FROM trustwork.subscription_plan_version ORDER BY id')) + JSON.stringify(await q('SELECT * FROM trustwork.offer ORDER BY id'));
    const before = await snapshot();
    assert.ok(before.includes(offer));
    const record = (input: { inputPerMillionTokens: string | null; outputPerMillionTokens: string | null }) => a.cmd(p.owner, (trx: Transaction, ctx: CommandContext) => modelPricing.record(trx, ctx, {
      connectionId: vendor.id, modelId: 'model-a', currency: 'USD', ...input, perImage: null, perAudioMinute: null, basis: 'provider_list', observedAt: new Date().toISOString(), sourceNote: 'Synthetic list price',
    }));
    const v1 = await record({ inputPerMillionTokens: '3.00', outputPerMillionTokens: '15.00' });
    const v2 = await record({ inputPerMillionTokens: '6.00', outputPerMillionTokens: '30.00' });
    assert.deepEqual([v1.version, v2.version], [1, 2]);
    assert.equal(v2.input_per_million_tokens, '6.000000');
    assert.equal(await snapshot(), before, 'no sale price, plan, meter rate or offer changed');
    await rejects(a.cmd(p.moderator, (trx, ctx) => modelPricing.record(trx, ctx, { connectionId: vendor.id, modelId: 'm', currency: 'USD', inputPerMillionTokens: '1', outputPerMillionTokens: null,
      perImage: null, perAudioMinute: null, basis: 'contract', observedAt: new Date().toISOString(), sourceNote: null })), '42501', 'admin.forbidden');
    assert.equal((await a.as(p.owner, (trx) => modelPricing.list(trx, hubA))).length, 2);
  });

  await t.test('every change is audited: actor, reason, before and after values; the admin audit row in the same transaction', async () => {
    const changes = await a.as(p.owner, (trx) => providerChanges.list(trx, hubA, { limit: 500 }));
    const kinds = new Set(changes.map((c) => c.object_type));
    for (const kind of ['provider_connection', 'secret_ref', 'connection_test', 'model_route', 'egress_rule', 'provider_budget', 'model_pricing', 'kill_switch']) assert.ok(kinds.has(kind), kind);
    for (const c of changes.filter((x) => x.actor_person_id !== null)) {
      assert.ok(c.reason.length > 0);
      assert.ok(c.request_id);
    }
    const update = changes.find((c) => c.action === 'providers.connection_updated')!;
    assert.ok(update.before && update.after);
    const audited = await count(db.admin, "SELECT 1 FROM trustwork.admin_audit_event WHERE hub_id = $1 AND action LIKE 'providers.%'", [hubA]);
    assert.ok(audited >= changes.filter((c) => c.action.startsWith('providers.') && c.actor_person_id !== null && c.object_type !== 'kill_switch').length);
    // No change image carries ciphertext or a key-shaped value.
    assert.equal(await count(db.admin, "SELECT 1 FROM trustwork.provider_config_change WHERE before::text ~ 'ciphertext|wrapped_key' OR after::text ~ 'ciphertext|wrapped_key'"), 0);
    // Staff of another hub read none of it.
    assert.equal((await a.as(p.otherOwner, (trx) => providerChanges.list(trx, hubA))).length, 0);
  });
});

async function count(admin: DataPool, query: string, params: unknown[] = []): Promise<number> {
  return (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${query}) q`, params)).rows[0]!.n;
}
