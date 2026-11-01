import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool, withMaintenance, withPrincipal } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { addLogins, signIn } from '../admin/helpers.js';
import { seedFixtures, principalFor } from '../data/helpers/seed.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { PrivacyPolicySchema, PrivacyTombstoneSchema } from '../../packages/contracts/src/privacy.js';
import type pg from 'pg';
import { privacyWorld } from './helpers.js';
import { privacyCrashRoutes } from '../backend/idempotency/cases/privacy.js';
import { installCrashPoints, recordState } from '../backend/idempotency/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../apps/api/src/common/idempotency/index.js';
import { PrivacyErasureLedger } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { RoleFence } from '../../scripts/restore/fence.js';
import { authorizeRestore, reconcileRestore } from '../../scripts/restore/reconcile.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import { buildAgreement, businessDate } from '../trust/helpers.js';

test('PRV-001: authenticated requests, preferences and delivery through real module projections', async (t) => {
  await t.test('privacy reaches other product modules only through the composition-root export port', async () => {
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
    assert.ok(!JSON.stringify(result.body).includes('Synthetic seller secret 1974'), 'the counterparty private side of the same agreement is never exported');
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.deepEqual(await store.list('privacy-exports/'), []);
  });
  await t.test('company authority is checked again at delivery after membership revocation', async () => {
    const created = await anna.post('/v1/privacy/exports', { subject: company });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body as { export: { id: string } }).export.id;
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
  await t.test('all five privacy mutations survive crash before and lost response after commit', async () => {
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
    const ledgerStore = new FilesystemBlobStore({ root, bucket: 'privacy-independent-ledger' });
    const ledger = new PrivacyErasureLedger(ledgerStore);
    const requestId = randomUUID();
    const tombstone = { version: 1 as const, requestId, subject, executedBy: world.people.officer, approvedBy: randomUUID(),
      policyDigest: '1'.repeat(64), recordedAt: new Date().toISOString(), modules: ['privacy'], suppressionDigests: ['2'.repeat(64)] };
    await ledger.record(tombstone); await ledger.record(tombstone);
    assert.equal((await ledger.all()).length, 1);
    await assert.rejects(ledger.record({ ...tombstone, policyDigest: '3'.repeat(64) }), /conflicting/);
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
    const authorization = { admin, fence, restoreId: 'synthetic-privacy-restore', reference: 'synthetic-fixture', operator: 'synthetic-privacy-test' };
    await assert.rejects(authorizeRestore(authorization), /external privacy ledger/);
    assert.ok(await fence.isApplied());
    await authorizeRestore({ ...authorization, privacyLedger: ledger });
    assert.equal(await fence.isApplied(), false);
    assert.equal((await admin.query('SELECT correction FROM trustwork.privacy_request WHERE subject_id=$1 AND correction IS NOT NULL', [subject.id])).rows[0]?.correction.redacted, true);
    assert.deepEqual(await readRestored(), []);
    assert.equal((await admin.query('SELECT do_not_collect FROM trustwork.privacy_suppression WHERE digest=$1', ['2'.repeat(64)])).rows[0]?.do_not_collect, true);
    // Model restoration of a pre-erasure database row; the independent ledger is not restored or deleted.
    await admin.query('DELETE FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [requestId]);
    await admin.query(`UPDATE trustwork.privacy_request SET correction='{"field":"profile","proposedValue":"Synthetic restored private value"}' WHERE subject_id=$1 AND kind='correction'`, [subject.id]);
    await fence.apply();
    await authorizeRestore({ ...authorization, privacyLedger: ledger });
    assert.deepEqual(await readRestored(), []);
    await ledger.record({ ...tombstone, requestId: randomUUID(), modules: ['communications'] });
    await fence.apply();
    await assert.rejects(authorizeRestore({ ...authorization, privacyLedger: ledger }), /adapter unavailable/);
    assert.ok(await fence.isApplied());
    const corruptStore = new FilesystemBlobStore({ root, bucket: 'privacy-corrupt-journal' });
    await corruptStore.put('privacy-erasure/corrupt.json', Buffer.from('{'));
    await assert.rejects(authorizeRestore({ ...authorization, privacyLedger: new PrivacyErasureLedger(corruptStore) }));
    assert.ok(await fence.isApplied());
    await fence.lift(); // Only this test's isolated login is restored for teardown.
  });
});
