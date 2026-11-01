import { installSyntheticServingHub } from '../agent-modules/serving-fixture.js';
import { REGISTRY } from '../agent-modules/fixtures.js';
import { engineDefaultPolicy } from '../../packages/contracts/src/agent-modules.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { seedFixtures, principalFor } from '../data/helpers/seed.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import { files } from '../../packages/data/src/repositories/files.js';
import { gate, waitFor } from '../worker/helpers/worker-db.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { PrivacyPolicySchema, PrivacyTombstoneSchema } from '../../packages/contracts/src/privacy.js';
import type pg from 'pg';
import { privacyWorld } from './helpers.js';
import { privacyCrashRoutes } from '../backend/idempotency/cases/privacy.js';
import { installCrashPoints, recordState } from '../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../apps/api/src/common/idempotency/index.js';
import { provisionLocalPrivacyJournal } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { RoleFence } from '../../scripts/restore/fence.js';
import { runLocalPrivacyRestoreCli } from '../../scripts/restore/cli.js';
import { authorizeLocalPrivacyRestore, reconcileRestore } from '../../scripts/restore/reconcile.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { buildAgreement, businessDate } from '../trust/helpers.js';
import { billingAccounts, catalogue as billingCatalogue, subscriptions, priceAcceptances, budgets } from '../../packages/data/src/repositories/billing.js';
import { buildAdminWorld } from '../data/admin/helpers.js';
import { agentReports } from '../../packages/data/src/repositories/agents.js';
import { publications } from '../../packages/data/src/repositories/content.js';
import { rfqInvitations } from '../../packages/data/src/repositories/commerce.js';
import { PRIVACY_MODULE_INVENTORY } from '../../apps/api/src/modules/platform-admin/privacy/inventory.js';
import { registerClient, tokensFor } from '../connections/oauth/helpers.js';

test('PRV-001: authenticated requests, preferences and delivery through real module projections', async (t) => {
  await t.test('privacy reaches other product modules only through the composition-root export port', async () => {
    assert.deepEqual([...PRIVACY_MODULE_INVENTORY].sort(), (await readdir(resolve('apps/api/src/modules'), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(), 'every implemented module must have an inventory entry');
    const directory = resolve('apps/api/src/modules/platform-admin/privacy');
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.ts')) continue;
      const path = join(directory, file);
      for (const match of (await readFile(path, 'utf8')).matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const target = resolve(dirname(path), match[1]!);
        const modules = resolve('apps/api/src/modules');
        assert.ok(!target.startsWith(modules) || target.startsWith(directory) || target.startsWith(join(modules, 'identity') + '/'), `${file} crosses its port: ${match[1]}`);
      }
    }
  });
  const root = await mkdtemp(join(tmpdir(), 'privacy-test-'));
  const store = new FilesystemBlobStore({ root });
  const logs: string[] = [];
  const h = await startHarness('privacy', { files: { store }, logSink: (line) => { logs.push(line); } });
  if (!h) { await rm(root, { recursive: true, force: true }); t.skip(SKIP_REASON); return; }
  t.after(async () => { await h.close(); await rm(root, { recursive: true, force: true }); });
  const servingHubId = await installSyntheticServingHub(h);
  assert.ok(engineDefaultPolicy(servingHubId, REGISTRY).policy.enabledModules.some(m => m.moduleKey === 'consultation'), 'the synthetic serving hub uses the enabled consultation default, without bypassing the owning gate');
  const seed = await seedFixtures(h.db.admin);
  await withMaintenance(h.db.admin, async (trx) => kernelSync.apply(trx, await kernelReference.fromRepository()));
  await withMaintenance(h.db.admin, (trx) => trx.updateTable('company_private').set({ internal_notes: 'Synthetic counterparty private sentinel 9371' }).where('company_id', '=', seed.companies.mixed).execute());
  await addLogins(h, [[seed.people.petr, 'synthetic-privacy-petr@example.invalid'], [seed.people.anna, 'synthetic-privacy-anna@example.invalid'], [seed.people.boris, 'synthetic-privacy-boris@example.invalid']]);
  const petr = h.client(); const anna = h.client(); const boris = h.client();
  await signIn(petr, 'synthetic-privacy-petr@example.invalid');
  await signIn(anna, 'synthetic-privacy-anna@example.invalid');
  await signIn(boris, 'synthetic-privacy-boris@example.invalid');
  const subject = { kind: 'person' as const, id: seed.people.petr };
  const company = { kind: 'company', id: seed.companies.mixed };
  await t.test('anonymous and other subjects cannot create/read private requests or exports', async () => {
    const mailBefore = await h.mail.countTo('synthetic-privacy-petr@example.invalid');
    assert.equal((await h.client().get('/v1/privacy/requests')).status, 401);
    assert.equal((await boris.post('/v1/privacy/requests', { subject, country: 'US', kind: 'access' })).status, 403);
    assert.equal((await boris.post('/v1/privacy/exports', { subject: company })).status, 403);
    const r = await petr.post('/v1/privacy/requests', { subject, country: 'US', kind: 'correction', correction: { field: 'profile', proposedValue: 'Synthetic private correction' } }, { idempotencyKey: 'privacy-correction' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((r.body as { policy_status: string }).policy_status, 'UNKNOWN');
    assert.equal((r.body as { deadline_at: unknown }).deadline_at, null);
    const replay = await petr.post('/v1/privacy/requests', { subject, country: 'US', kind: 'correction', correction: { field: 'profile', proposedValue: 'Synthetic private correction' } }, { idempotencyKey: 'privacy-correction' });
    assert.deepEqual(replay.body, r.body);
    assert.deepEqual((await boris.get('/v1/privacy/requests')).body, { requests: [] });
    const p = await principalFor(h.db.admin, seed.people.boris);
    assert.deepEqual(await withPrincipal(h.pool, p, (trx) => privacy.requests(trx)), []);
    await assert.rejects(withPrincipal(h.pool, p, (trx) => trx.updateTable('privacy_request').set({ state: 'completed' }).execute()));
    assert.equal(await h.mail.countTo('synthetic-privacy-petr@example.invalid'), mailBefore, 'correction data never enters a notification');
  });
  await t.test('only explicitly sourced synthetic policy values create deadlines', async () => {
    await withMaintenance(h.db.admin, (trx) => trx.insertInto('privacy_country_policy').values({ country: 'ZZ', version: 'synthetic-policy-v1', review: 'verified',
      sources: JSON.stringify(['https://example.invalid/synthetic-policy']), deadline_days: 3, retention_days: 7, registry_poll_hours: 6, registry_deadline_days: 4 }).execute());
    const r = await petr.post('/v1/privacy/requests', { subject, country: 'ZZ', kind: 'erasure' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const body = r.body as { created_at: string; deadline_at: string; retention_days: number };
    assert.equal(Date.parse(body.deadline_at) - Date.parse(body.created_at), 3 * 86_400_000);
    assert.equal(body.retention_days, 7);
    assert.equal(PrivacyPolicySchema.safeParse({ country: 'US', version: 'invented', review: 'verified', sources: [], deadlineDays: 30, retentionDays: 30, registryPollHours: null, registryDeadlineDays: null }).success, false);
  });
  await t.test('GPC and objections are durable data; concurrent updates cannot undo an objection', async () => {
    const base = { optOutSale: false, optOutSharing: false, limitSensitive: false, directMarketingObjection: false, gpc: false };
    const responses = await Promise.all([
      petr.post('/v1/privacy/preferences', { ...base, gpc: true, directMarketingObjection: true }),
      petr.post('/v1/privacy/preferences', base),
    ]);
    for (const r of responses) assert.equal(r.status, 200, JSON.stringify(r.body));
    const r = await petr.get('/v1/privacy/preferences');
    const pref = (r.body as { preference: Record<string, unknown> }).preference;
    assert.equal(pref.gpc, true); assert.equal(pref.direct_marketing_objection, true); assert.equal(pref.opt_out_sale, true); assert.equal(pref.opt_out_sharing, true);
    assert.equal((await h.db.admin.query('SELECT digest FROM trustwork.privacy_suppression WHERE person_id=$1', [subject.id])).rowCount, 1);
    assert.deepEqual((await boris.get('/v1/privacy/preferences')).body, { preference: null });
  });
  await t.test('unpaid subject can download own existing projections, never another company private fields', async () => {
    const fixture = await buildAgreement({ admin: h.db.admin, app: h.pool, people: seed.people, supplier: seed.companies.supplier, project: seed.project }, businessDate(20));
    await withPrincipal(h.pool, await principalFor(h.db.admin, seed.people.boris), (trx) => trx.insertInto('agreement_seller_private').values({ agreement_id: fixture.agreement.id, owner_person_id: null,
      owner_company_id: seed.companies.supplier, fulfilment_plan: JSON.stringify([]), notes: 'Synthetic seller secret 1974', updated_by_person_id: seed.people.boris }).execute());
    const created = await petr.post('/v1/privacy/exports', { subject });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { export: { id: string } }).export.id;
    assert.equal((await boris.get(`/v1/privacy/exports/${id}`)).status, 404);
    const result = await petr.get(`/v1/privacy/exports/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const archive = (result.body as { archive: { complete: boolean; data: { projects: unknown[] }; coverage: unknown[] } }).archive;
    assert.equal(archive.complete, false, 'partial coverage must never masquerade as a full export');
    assert.equal(archive.data.projects.length, 1);
    assert.ok(!JSON.stringify(result.body).includes('Synthetic counterparty private sentinel 9371'), 'counterparty private note is not exported');
    assert.ok(JSON.stringify(result.body).includes(fixture.agreement.id), 'the authorized shared agreement is exported');
    assert.ok(!JSON.stringify(result.body).includes('tokenHash') && !JSON.stringify(result.body).includes('token_hash'), 'session token material never reaches the archive');
    assert.ok(!JSON.stringify(result.body).includes('Synthetic seller secret 1974'), 'the counterparty private side of the same agreement is never exported');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(await store.list('privacy-exports/'), []);
  });
  await t.test('RFQ and quote histories use owning COMMS projections without exporting employer threads as personal data', async () => {
    const fixture = await buildAgreement({ admin: h.db.admin, app: h.pool, people: seed.people, supplier: seed.companies.supplier, project: seed.project }, businessDate(20));
    const ids: string[] = [];
    for (const kind of ['rfq', 'quote'] as const) {
      const opened = await petr.post('/v1/threads', { context: { kind, id: kind === 'rfq' ? fixture.agreement.rfq_id : fixture.agreement.quote_id },
        subject: 'Synthetic privacy context history', counterparty: kind === 'rfq' ? { kind: 'company', id: seed.companies.supplier } : null,
        message: { body: `Synthetic ${kind} context private-to-parties 6492`, links: [], onBehalfOfCompany: false, actor: { via: 'person' } } });
      assert.equal(opened.status, 201, JSON.stringify(opened.body)); ids.push((opened.body as { thread: { id: string } }).thread.id);
    }
    const own = await petr.post('/v1/privacy/exports', { subject });
    const response = await petr.get(`/v1/privacy/exports/${(own.body as { export: { id: string } }).export.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (const id of ids) assert.ok(JSON.stringify(response.body).includes(id));
    assert.ok(JSON.stringify(response.body).includes('Synthetic rfq context private-to-parties 6492'));
    assert.ok(JSON.stringify(response.body).includes('Synthetic quote context private-to-parties 6492'));
    const personal = await boris.post('/v1/privacy/exports', { subject: { kind: 'person', id: seed.people.boris } });
    const excluded = await boris.get(`/v1/privacy/exports/${(personal.body as { export: { id: string } }).export.id}`);
    assert.equal(excluded.status, 200, JSON.stringify(excluded.body));
    const personalThreads = (excluded.body as { archive: { data: { communications: { threads: unknown[] } } } }).archive.data.communications.threads;
    for (const id of ids) assert.ok(!JSON.stringify(personalThreads).includes(id), 'employer threads stay outside the personal export; own notifications retain their permitted links');
  });
  await t.test('personal participating projects use shared projections and disappear after actual revocation', async () => {
    const target = { kind: 'person', id: seed.people.boris };
    const created = await boris.post('/v1/privacy/exports', { subject: target });
    const id = (created.body as { export: { id: string } }).export.id;
    const before = await boris.get(`/v1/privacy/exports/${id}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual((before.body as { archive: { data: { participatingProjects: unknown[] } } }).archive.data.participatingProjects, [], 'employer participation is not personal participation');
    const granted = await petr.post(`/v1/projects/${seed.project}/participants`, { party: target, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', validUntil: null });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const grant = granted.body as { id: string; revision: number };
    const during = await boris.get(`/v1/privacy/exports/${id}`);
    assert.equal(during.status, 200, JSON.stringify(during.body));
    const projects = (during.body as { archive: { data: { participatingProjects: { projection: string; project: { id: string } }[] } } }).archive.data.participatingProjects;
    assert.equal(projects.length, 1); assert.equal(projects[0]!.project.id, seed.project); assert.equal(projects[0]!.projection, 'shared_party');
    assert.ok(!JSON.stringify(projects).includes('privateNotes') && !JSON.stringify(projects).includes('budgets'));
    const revoked = await petr.post(`/v1/projects/${seed.project}/participants/${grant.id}/revoke`, { expectedRevision: grant.revision, reason: 'Synthetic privacy current-authority check' });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const after = await boris.get(`/v1/privacy/exports/${id}`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    assert.deepEqual((after.body as { archive: { data: { participatingProjects: unknown[] } } }).archive.data.participatingProjects, []);
  });
  await t.test('personal supplier export includes pinned versions but no employer invitations or buyer private constraints', async () => {
    const target = { kind: 'person', id: seed.people.boris };
    const created = await boris.post('/v1/privacy/exports', { subject: target });
    const id = (created.body as { export: { id: string } }).export.id;
    const before = await boris.get(`/v1/privacy/exports/${id}`);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual((before.body as { archive: { data: { supplierInvitations: { invitations: unknown[] } } } }).archive.data.supplierInvitations.invitations, []);
    const rfq = await withMaintenance(h.db.admin, (trx) => trx.selectFrom('rfq').select(['id', 'current_version_id']).where('owner_person_id', '=', subject.id).executeTakeFirstOrThrow());
    const invitation = await withPrincipal(h.pool, await principalFor(h.db.admin, subject.id), (trx) => rfqInvitations.insert(trx, { rfq_id: rfq.id, rfq_version_id: rfq.current_version_id!, party_person_id: target.id, party_company_id: null,
      channel: 'platform', sent_by_person_id: subject.id, sent_via: 'person', sent_by_mandate_id: null, revalidates_invitation_id: null }));
    const after = await boris.get(`/v1/privacy/exports/${id}`);
    assert.equal(after.status, 200, JSON.stringify(after.body));
    const supplier = (after.body as { archive: { data: { supplierInvitations: { invitations: { invitation: { id: string } }[]; rfqs: unknown[] } } } }).archive.data.supplierInvitations;
    assert.equal(supplier.invitations.length, 1); assert.equal(supplier.invitations[0]!.invitation.id, invitation.id);
    assert.ok(JSON.stringify(supplier.rfqs).includes(rfq.current_version_id!));
    assert.ok(!JSON.stringify(supplier).includes('PRIVATE-ceiling') && !JSON.stringify(supplier).includes('privateConstraint'));
    assert.ok(!JSON.stringify(supplier).includes(seed.companies.supplier), 'company invitation is outside the personal export');
  });
  await t.test('own clean file bytes are authorized and digest checked; counterparty bytes and storage paths stay out', async () => {
    const seedFile = async (personId: string, marker: string) => {
      const body = Buffer.from(marker); const key = `synthetic-files/${randomUUID()}`;
      await store.put(key, body);
      const row = await withMaintenance(h.db.admin, (trx) => trx.insertInto('evidence_artifact').values({ owner_person_id: personId, parent_kind: 'person', parent_id: personId,
        classification: 'owner_private', storage_key: key, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, media_type: 'text/plain', scan_state: 'clean', uploaded_by: personId }).returning('id').executeTakeFirstOrThrow());
      return { ...row, key, body };
    };
    const own = await seedFile(subject.id, 'Synthetic own binary 8842');
    const other = await seedFile(seed.people.boris, 'Synthetic counterparty binary 8843');
    const created = await petr.post('/v1/privacy/exports', { subject });
    const id = (created.body as { export: { id: string } }).export.id;
    const result = await petr.get(`/v1/privacy/exports/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const text = JSON.stringify(result.body);
    assert.ok(text.includes(own.body.toString('base64')));
    assert.ok(!text.includes(other.body.toString('base64')) && !text.includes(other.id));
    assert.ok(!text.includes(own.key) && !text.includes('storage_key'));
    await store.put(own.key, Buffer.from('corrupt'));
    assert.equal((await petr.get(`/v1/privacy/exports/${id}`)).status, 500, 'corrupt content cannot be delivered as a successful archive');
    await store.put(own.key, own.body);
  });
  await t.test('files beyond the inline limit stream verified bytes with current authority and bounded chunks', async () => {
    const body = Buffer.alloc(17 * 1024 * 1024 + 3, 65); const key = `synthetic-files/${randomUUID()}`;
    await store.put(key, body);
    const file = await withMaintenance(h.db.admin, (trx) => trx.insertInto('evidence_artifact').values({ owner_person_id: subject.id, parent_kind: 'person', parent_id: subject.id,
      classification: 'owner_private', storage_key: key, sha256: createHash('sha256').update(body).digest('hex'), bytes: body.length, media_type: 'text/plain', scan_state: 'clean', uploaded_by: subject.id }).returning('id').executeTakeFirstOrThrow());
    const created = await petr.post('/v1/privacy/exports', { subject });
    const id = (created.body as { export: { id: string } }).export.id;
    const metadata = await petr.get(`/v1/privacy/exports/${id}`);
    assert.equal(metadata.status, 200);
    assert.ok(JSON.stringify(metadata.body).includes('authenticated_stream_available'));
    assert.ok(!JSON.stringify(metadata.body).includes(key));
    const url = `/v1/privacy/exports/${id}/files/${file.id}`;
    assert.equal((await boris.get(url)).status, 404);
    assert.equal((await h.client().get(url)).status, 401);
    const read = store.stream.bind(store); let maxChunk = 0;
    const entered = gate(); const release = gate();
    store.stream = async function* (storageKey: string) {
      for await (const chunk of read(storageKey)) {
        maxChunk = Math.max(maxChunk, chunk.length);
        if (storageKey === key) { entered.open(); await release.promise; }
        yield chunk;
      }
    };
    const downloading = petr.get(url);
    await entered.promise;
    const deletion = withPrincipal(h.pool, await principalFor(h.db.admin, subject.id), (trx) => files.requestDeletion(trx, file.id));
    try {
      await waitFor(async () => (await h.db.admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%files_request_deletion%') AS blocked")).rows[0].blocked,
        5000, 'owning file deletion waits through verified download');
    } finally { release.open(); }
    const result = await downloading; await deletion; store.stream = read;
    assert.equal(result.status, 200); assert.equal(Buffer.byteLength(result.body as string), body.length);
    assert.equal(createHash('sha256').update(result.body as string).digest('hex'), createHash('sha256').update(body).digest('hex'));
    assert.ok(maxChunk <= 64 * 1024); assert.equal(result.headers['cache-control'], 'no-store');
    assert.equal((await petr.get(url)).status, 404, 'current deletion authority checked on every stream download');
  });
  await t.test('own publication drafts export through CNT projections without a counterparty draft', async () => {
    await buildAdminWorld(h.db.admin);
    const hubId = (await h.db.admin.query<{ id: string }>('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0]!.id;
    const create = async (personId: string, body: string) => withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => publications.create(trx, null, {
      hubId, owner: { kind: 'person' }, format: 'article', articleFormat: null, language: 'en', licence: 'all_rights', requiresReview: false,
      draft: { title: 'Synthetic private draft', body, language: 'en', sourceRefs: [], treatment: 'original_reporting', eventTime: null, assistantAssisted: false },
      authorship: [{ kind: 'person', id: personId, credit: 'Synthetic author', assistantAssisted: false }],
    }));
    await create(subject.id, 'Synthetic own publication export 2481');
    await create(seed.people.boris, 'Synthetic other publication excluded 7261');
    const created = await petr.post('/v1/privacy/exports', { subject });
    const id = (created.body as { export: { id: string } }).export.id;
    const result = await petr.get(`/v1/privacy/exports/${id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.ok(JSON.stringify(result.body).includes('Synthetic own publication export 2481'));
    assert.ok(!JSON.stringify(result.body).includes('Synthetic other publication excluded 7261'));
  });
  await t.test('owning consent history and closed availability export without another subject or token material', async () => {
    const clientId = await registerClient(h);
    const first = await tokensFor(h, petr, clientId, { prompt: 'consent' });
    const second = await tokensFor(h, petr, clientId, { prompt: 'consent' });
    const other = await tokensFor(h, boris, clientId, { prompt: 'consent' });
    const opened = await petr.post('/v1/consultation-availability', { startsAt: new Date(Date.now() + 3600000).toISOString(), endsAt: new Date(Date.now() + 7200000).toISOString(), timeZone: 'UTC', capacity: 1, actor: { via: 'person' } });
    assert.equal(opened.status, 201, JSON.stringify(opened.body)); const window = opened.body as { id: string; revision: number };
    assert.equal((await petr.post(`/v1/consultation-availability/${window.id}/close`, { expectedRevision: window.revision, actor: { via: 'person' } })).status, 200);
    const created = await petr.post('/v1/privacy/exports', { subject }); const id = (created.body as { export: { id: string } }).export.id;
    const result = await petr.get(`/v1/privacy/exports/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = (result.body as { archive: { data: { connections: { consents: { withdrawnReason: string | null }[] }; consultations: { availability: { id: string; status: string }[] } } } }).archive.data;
    assert.equal(data.connections.consents.length, 2); assert.ok(data.connections.consents.some((r) => r.withdrawnReason === 'superseded'));
    assert.equal(data.consultations.availability.find((r) => r.id === window.id)!.status, 'closed');
    for (const tokens of [first, second, other]) for (const secret of [tokens.access_token, tokens.refresh_token]) assert.ok(!JSON.stringify(result.body).includes(secret));
    assert.ok(!JSON.stringify(data.connections).includes('elevationId'));
  });
  await t.test('owning export includes history beyond UI caps and never support internals', async () => {
    const hubId = (await h.db.admin.query('SELECT id FROM trustwork.hub ORDER BY id LIMIT 1')).rows[0].id;
    const ids: string[] = [];
    for (let i = 0; i < 201; i++) {
      const r = await petr.post('/v1/support/cases', { hubId, category: 'privacy', summary: `Synthetic export history ${i}` });
      assert.equal(r.status, 201, JSON.stringify(r.body)); ids.push((r.body as { case: { id: string } }).case.id);
    }
    const diagnostic = await petr.post(`/v1/support/cases/${ids[0]}/diagnostics`, { pageId: 'privacy', appVersion: 'synthetic-v1', locale: 'en', featureFlags: [], errorCodes: [], requestIds: [], objects: [] });
    assert.equal(diagnostic.status, 201, JSON.stringify(diagnostic.body));
    await withMaintenance(h.db.admin, async (trx) => {
      await trx.insertInto('support_case_note').values({ support_case_id: ids[0]!, author_person_id: seed.people.anna, visibility: 'internal', body: 'Synthetic internal note must stay private' }).execute();
      for (let i = 0; i < 201; i++) {
        await trx.insertInto('support_access_record').values({ hub_id: hubId, actor_person_id: seed.people.anna, subject_person_id: subject.id, support_case_id: ids[0]!, kind: 'account_card' }).execute();
      }
    });
    const message = (body: string) => ({ body, links: [], onBehalfOfCompany: false, actor: { via: 'person' } });
    const opened = await petr.post('/v1/threads', { context: { kind: 'project', id: seed.project }, subject: 'Synthetic history', counterparty: null, message: message('Synthetic first historical message') });
    assert.equal(opened.status, 201, JSON.stringify(opened.body)); const threadId = (opened.body as { thread: { id: string } }).thread.id;
    for (let i = 0; i < 200; i++) {
      const r = await petr.post(`/v1/threads/${threadId}/messages`, message(`Synthetic history ${i}`)); assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const created = await petr.post('/v1/privacy/exports', { subject }); const id = (created.body as { export: { id: string } }).export.id;
    const result = await petr.get(`/v1/privacy/exports/${id}`); assert.equal(result.status, 200, JSON.stringify(result.body));
    const data = (result.body as { archive: { data: { support: { cases: { case: { id: string }; diagnostics: unknown[] }[]; access: { records: unknown[] } }; communications: { threads: { thread: { id: string }; messages: unknown[] }[] } } } }).archive.data;
    assert.equal(data.support.cases.length, 201); assert.equal(data.support.access.records.length, 201);
    assert.equal(data.support.cases.find((r) => r.case.id === ids[0])!.diagnostics.length, 1);
    assert.equal(data.communications.threads.find((r) => r.thread.id === threadId)!.messages.length, 201);
    assert.ok(JSON.stringify(data.communications).includes('Synthetic first historical message'));
    assert.ok(!JSON.stringify(data.support).includes('Synthetic internal note must stay private'));
    assert.ok(!JSON.stringify(data.support).includes(seed.people.anna));
    assert.equal((await boris.get(`/v1/privacy/exports/${id}`)).status, 404);
  });
  await t.test('own personal agent reports export without other agents or employer internals', async () => {
    const insert = async (personId: string, companyId: string | null, marker: string) => withPrincipal(h.pool, await principalFor(h.db.admin, personId), (trx) => agentReports.insert(trx, {
      author_person_id: personId, principal_company_id: companyId, goal_id: null, run_id: null,
      period_from: new Date(Date.now()-1000), period_to: new Date(), sections: [{ kind: 'summary', text: marker }],
    }));
    await insert(subject.id, null, 'Synthetic own agent report 4972');
    await insert(seed.people.boris, null, 'Synthetic other agent report 4973');
    await insert(seed.people.anna, company.id, 'Synthetic employer internal report 4974');
    const created = await petr.post('/v1/privacy/exports', { subject });
    const result = await petr.get(`/v1/privacy/exports/${(created.body as { export: { id: string } }).export.id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const text = JSON.stringify(result.body);
    assert.ok(text.includes('Synthetic own agent report 4972'));
    assert.ok(!text.includes('Synthetic other agent report 4973') && !text.includes('Synthetic employer internal report 4974'));
    const ownCompanyPerson = await anna.post('/v1/privacy/exports', { subject: { kind: 'person', id: seed.people.anna } });
    const ownCompanyExport = await anna.get(`/v1/privacy/exports/${(ownCompanyPerson.body as { export: { id: string } }).export.id}`);
    assert.equal(ownCompanyExport.status, 200, JSON.stringify(ownCompanyExport.body));
    assert.ok(!JSON.stringify(ownCompanyExport.body).includes('Synthetic employer internal report 4974'), 'a person export does not become an employer export');
  });
  await t.test('an exactly ended paid subscription preserves export and excludes counterparty platform budgets', async () => {
    const hubId = randomUUID();
    const owner = <T>(fn: Parameters<typeof withMaintenance<T>>[1]) => withMaintenance(h.db.admin, fn);
    const as = async <T>(personId: string, fn: Parameters<typeof withPrincipal<T>>[2]) => withPrincipal(h.pool, await principalFor(h.db.admin, personId), fn);
    const offer = await owner((trx) => billingCatalogue.createOffer(trx, { hubId, code: 'synthetic_privacy_paid_plan', name: 'Synthetic Paid Plan', kind: 'plan', status: 'active', createdBy: seed.people.anna }));
    let price = await owner((trx) => billingCatalogue.draftPriceVersion(trx, { offerId: offer.id, amountMinor: '39900', currency: 'USD', effectiveFrom: new Date(Date.now() + 60000), acceptanceTextVersion: 'synthetic-terms-1', draftedBy: seed.people.anna }));
    price = await owner((trx) => billingCatalogue.activatePriceVersion(trx, price.id, seed.people.boris));
    const account = await as(subject.id, (trx) => billingAccounts.open(trx, { hubId, owner: subject, currency: 'USD', createdBy: subject.id }));
    const accepted = await as(subject.id, (trx) => priceAcceptances.accept(trx, { priceVersionId: price.id, billingAccountId: account.id, payer: subject,
      acceptedBy: subject.id, amountMinor: price.amount_minor, currency: 'USD', acceptanceTextVersion: price.acceptance_text_version }));
    const sub = await owner((trx) => subscriptions.start(trx, { billingAccountId: account.id, offerId: offer.id, planVersionId: null, priceVersionId: price.id, priceAcceptanceId: accepted.id,
      status: 'active', periodStart: new Date(Date.now() - 86400000), periodEnd: new Date(Date.now() - 1000), renewsAt: null }));
    await owner((trx) => trx.updateTable('subscription').set({ status: 'ended' }).where('id', '=', sub.id).execute());
    const secretBudget = await as(seed.people.boris, (trx) => budgets.grant(trx, { kind: 'platform', owner: 'person', projectId: null, employeePersonId: null,
      periodFrom: new Date(Date.now() - 1000), periodTo: new Date(Date.now() + 86400000), limitMinor: '938471', currency: 'USD' }));
    const created = await petr.post('/v1/privacy/exports', { subject });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const result = await petr.get(`/v1/privacy/exports/${(created.body as { export: { id: string } }).export.id}`);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const text = JSON.stringify(result.body);
    assert.ok(text.includes(sub.id)); assert.ok(text.includes('ended')); assert.ok(text.includes('39900'));
    assert.ok(!text.includes(secretBudget)); assert.ok(!text.includes('938471'));
    const archive = (result.body as { archive: { complete: boolean; coverage: { module: string; status: string; includes: string }[] } }).archive;
    assert.equal(archive.complete, false);
    assert.deepEqual(archive.coverage.map((r) => r.module).sort(), [...PRIVACY_MODULE_INVENTORY].sort());
    assert.deepEqual(archive.coverage.find((r) => r.module === 'agent-modules'), { module: 'agent-modules', status: 'unsupported', includes: 'owning module exporter unavailable; not omitted from the inventory' });
  });
  await t.test('company authority is checked again at delivery after membership revocation', async () => {
    const created = await anna.post('/v1/privacy/exports', { subject: company });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { export: { id: string } }).export.id;
    const beforeRevocation = await anna.get(`/v1/privacy/exports/${id}`);
    assert.equal(beforeRevocation.status, 200, JSON.stringify(beforeRevocation.body));
    assert.ok(JSON.stringify(beforeRevocation.body).includes('Synthetic counterparty private sentinel 9371'), 'the company administrator receives the own-company private projection');
    await withMaintenance(h.db.admin, (trx) => trx.updateTable('membership').set({ status: 'ended', ended_at: new Date(), ended_by: seed.people.anna, ended_reason: 'Synthetic revocation' }).where('id', '=', seed.memberships.anna).execute());
    assert.equal((await anna.get(`/v1/privacy/exports/${id}`)).status, 404);
  });
  await t.test('a tombstone cannot encode self-approval or arbitrary paths', () => {
    const person = randomUUID();
    const record = { version: 1, requestId: randomUUID(), subject, executedBy: person, approvedBy: person, policyDigest: '0'.repeat(64), recordedAt: new Date().toISOString(), modules: ['privacy'], suppressionDigests: [] };
    assert.equal(PrivacyTombstoneSchema.safeParse(record).success, false);
    assert.equal(PrivacyTombstoneSchema.safeParse({ ...record, approvedBy: randomUUID(), storageKey: '/tmp/arbitrary' }).success, false);
  });
  const world = await privacyWorld(h);
  await t.test('audited hold and erasure readiness serialize; unknown laws and missing adapters block effects', async () => {
    const r = await world.subject.post('/v1/privacy/requests', { subject: { kind: 'person', id: world.people.subject }, country: 'ZZ', kind: 'erasure' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const requestId = (r.body as { id: string }).id;
    const ctx = await world.context(world.people.officer);
    const forbidden = await petr.post('/v1/admin/privacy/holds', { requestId, reasonCode: 'litigation', evidenceRef: randomUUID() });
    assert.equal(forbidden.status, 403);
    let entered!: () => void; const hasLock = new Promise<void>((resolve) => { entered = resolve; });
    let proceed!: () => void; const gate = new Promise<void>((resolve) => { proceed = resolve; });
    const placing = world.as(world.people.officer, async (trx) => {
      const held = await privacy.hold(trx, ctx, requestId, 'litigation', randomUUID()); entered(); await gate; return held;
    });
    await hasLock;
    const checking = world.as(world.people.officer, (trx) => privacy.erasureCheck(trx, ctx, requestId));
    proceed(); const hold = await placing;
    assert.deepEqual(await checking, { ready: false, reason: 'legal_hold' });
    await world.as(world.people.officer, (trx) => privacy.releaseHold(trx, ctx, hold.id));
    assert.deepEqual(await world.as(world.people.officer, (trx) => privacy.erasureCheck(trx, ctx, requestId)), { ready: false, reason: 'module_erasure_adapters_unavailable' });
    const audit = await h.db.admin.query<{ action: string; reason_text: string }>("SELECT action, reason_text FROM trustwork.admin_audit_event WHERE object_id=$1 ORDER BY id", [hold.id]);
    assert.deepEqual(audit.rows.map((a) => a.action), ['privacy.hold_placed', 'privacy.hold_released']);
    assert.ok(audit.rows.every((a) => !a.reason_text.includes('Synthetic private correction')));
  });
  await t.test('privacy mutations survive crash before and lost response after commit', async () => {
    const crash = await installCrashPoints(h.db.admin as unknown as pg.Pool);
    await privacyCrashRoutes(h, async (route) => {
      const key = `privacy-local-crash-${route.action}`;
      const send = () => route.client.post(route.url, route.body, { idempotencyKey: key });
      const before = await route.effects();
      try {
        await crash.arm('handler', 'bookkeeping');
        assert.equal((await send()).status, 500);
        assert.equal(await route.effects(), before);
        await crash.disarm('handler');
        assert.equal((await send()).status, 409);
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
        const done = await send();
        assert.ok(done.status >= 200 && done.status < 300, JSON.stringify(done.body));
        assert.equal((await recordState(h.db.admin as unknown as pg.Pool, key))?.state, 'completed');
        assert.equal(await route.effects(), before + 1);
        h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1000);
        assert.deepEqual((await send()).body, done.body);
        assert.equal(await route.effects(), before + 1);
        return done;
      } finally { await crash.clear(); h.clock.reset(); }
    }, world);
  });
  await t.test('privacy request logs carry no private payload or address, including injected crashes', () => {
    const privacyLogs = logs.filter((line) => line.includes('/privacy/'));
    assert.ok(privacyLogs.length > 0);
    for (const line of privacyLogs) {
      for (const forbidden of ['Synthetic private correction', 'Synthetic seller secret 1974', 'Synthetic counterparty private sentinel 9371', '@example.invalid']) {
        assert.ok(!line.includes(forbidden), 'private value appeared in a privacy request log');
      }
    }
  });
  await t.test('narrow synthetic restore: external ledger replays before runtime login; corrupt or unsupported records keep the fence', async () => {
    const admin = h.db.admin as unknown as pg.Pool;
    const binding = { authorityDirectory: join(root, 'authority'), journalDirectory: join(root, 'journal'), journalId: randomUUID() };
    const ledger = await provisionLocalPrivacyJournal(binding);
    const requestId = randomUUID();
    const tombstone = { version: 1 as const, requestId, subject, executedBy: world.people.officer, approvedBy: randomUUID(),
      policyDigest: '1'.repeat(64), recordedAt: new Date().toISOString(), modules: ['privacy'], suppressionDigests: ['2'.repeat(64)] };
    await ledger.record(tombstone); await ledger.record(tombstone);
    assert.equal((await ledger.all()).length, 1);
    const fence = new RoleFence(admin, [h.db.appLoginRole]);
    // Shut down only this test's API and pools before fencing. No other session or shared worker is touched.
    await h.created.close(); await h.pool.end(); await h.db.app.end();
    const readRestored = async () => {
      const runtime = createPool(h.db.appConfig);
      try { return await withPrincipal(runtime, await principalFor(h.db.admin, subject.id), (trx) => privacy.requests(trx)); }
      finally { await runtime.end(); }
    };
    await fence.apply();
    await assert.rejects(readRestored(), /not permitted to log in/);
    const now = new Date();
    await reconcileRestore({ admin, restoreId: 'synthetic-privacy-restore', recoveryPoint: now, restoreStartedAt: now,
      journal: { receipts: [], completeThrough: now }, operator: 'synthetic-privacy-test' });
    const authorization = { admin, fence, retainedAuthority: { directory: binding.authorityDirectory, journalId: binding.journalId }, restoreId: 'synthetic-privacy-restore', reference: 'synthetic-fixture', operator: 'synthetic-privacy-test' };
    await assert.rejects(authorizeLocalPrivacyRestore({ ...authorization, privacyLedger: undefined! }), /retained privacy authority/);
    assert.ok(await fence.isApplied());
    const cli = (pin: typeof binding) => runLocalPrivacyRestoreCli(['authorize', '--restore-id', authorization.restoreId,
      '--reference', authorization.reference, '--operator', authorization.operator, '--logins', h.db.appLoginRole],
    { RESTORE_DATABASE_URL: new URL(`/${h.db.databaseName}`, h.db.clusterUrl).toString() }, { out: () => undefined, err: () => undefined }, pin);
    assert.equal(await cli(undefined!), 1, 'the local privacy CLI cannot omit its independent authority');
    assert.ok(await fence.isApplied());
    assert.equal(await cli({ ...binding, authorityDirectory: join(root, 'missing-authority') }), 1);
    assert.ok(await fence.isApplied());
    assert.equal(await cli(binding), 0);
    assert.equal(await fence.isApplied(), false);
    assert.equal((await admin.query('SELECT correction FROM trustwork.privacy_request WHERE subject_id=$1 AND correction IS NOT NULL', [subject.id])).rows[0]?.correction.redacted, true);
    assert.deepEqual(await readRestored(), []);
    assert.equal((await admin.query('SELECT do_not_collect FROM trustwork.privacy_suppression WHERE digest=$1', ['2'.repeat(64)])).rows[0]?.do_not_collect, true);
    // Model restoration of a pre-erasure database row; the independent ledger is not restored or deleted.
    await admin.query('DELETE FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [requestId]);
    await admin.query(`UPDATE trustwork.privacy_request SET correction='{"field":"profile","proposedValue":"Synthetic restored private value"}' WHERE subject_id=$1 AND kind='correction'`, [subject.id]);
    await fence.apply();
    await authorizeLocalPrivacyRestore({ ...authorization, privacyLedger: ledger });
    assert.deepEqual(await readRestored(), []);
    const unsupported = await provisionLocalPrivacyJournal({ authorityDirectory: join(root, 'unsupported-authority'), journalDirectory: join(root, 'unsupported-journal'), journalId: randomUUID() });
    await unsupported.record({ ...tombstone, requestId: randomUUID(), modules: ['communications'] });
    await fence.apply();
    await assert.rejects(authorizeLocalPrivacyRestore({ ...authorization, privacyLedger: unsupported, retainedAuthority: { directory: unsupported.binding.authorityDirectory, journalId: unsupported.binding.journalId } }), /adapter unavailable/);
    assert.ok(await fence.isApplied());
    await fence.lift(); // Only this test's isolated login is restored for teardown.
  });
});
