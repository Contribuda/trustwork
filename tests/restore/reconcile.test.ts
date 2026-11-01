import { PrivacyErasureLedger } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { inbox, jobs } from '@trustwork/data';
import { HandlerRegistry, Worker } from '@trustwork/worker';
import { RoleFence } from '../../scripts/restore/fence.js';
import { authorizeRestore, AuthorizationRefused, readReceiptJournal, reconcileRestore, resolveOutboxEvent, type JobMode, type ProviderReceipt } from '../../scripts/restore/reconcile.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';

const env = await provisionWorkerDatabase('restore_reconcile');
const MODES: Record<string, JobMode> = { 'restore.tx': 'transactional' };

test('OPS-003 restore reconciliation on real PostgreSQL: fenced workers, receipts, lost leases, ambiguous outbox, authorization', { skip: env ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!env) return;
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-reconcile-'));
  t.after(async () => {
    // The fence touches only this file's own worker login; make sure it can log in again before it is dropped.
    await env.db.admin.query(`ALTER ROLE ${env.workerLoginRole} LOGIN`).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    await env.close();
  });
  const admin = env.db.admin as unknown as pg.Pool;
  const privacyLedger = new PrivacyErasureLedger(new FilesystemBlobStore({ root: dir, bucket: 'privacy-restore-ledger' }));
  const calls: string[] = [];
  const registry = () => new HandlerRegistry()
    .onJob({ kind: 'restore.external', mode: 'external', run: async (ctx) => void calls.push(ctx.effectKey) })
    .onJob<{ n: string }>({ kind: 'restore.tx', mode: 'transactional', run: async (ctx) => void (await inbox.record(ctx.trx, { provider: 'restore-test', account: 'tx', event_id: ctx.job.id })) })
    .onOutbox({ name: 'restore.relay', type: 'restore.requested', handle: async (event, ctx) => void (await ctx.enqueue({ kind: 'restore.external', payload: { eventId: event.id } })) });
  const job = async (kind: string, state: 'queued' | 'leased' | 'outcome_unknown', lastError: string | null = null) => {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO trustwork.job (kind, payload, state, leased_until, leased_by, attempt, fencing_token, last_error)
      VALUES ($1, '{}', $2, CASE WHEN $2 = 'leased' THEN now() + interval '10 minutes' END, CASE WHEN $2 = 'leased' THEN 'lost-primary' END, CASE WHEN $2 = 'queued' THEN 0 ELSE 1 END, CASE WHEN $2 = 'queued' THEN 0 ELSE 1 END, $3) RETURNING id`, [kind, state, lastError]);
    return rows[0]!.id;
  };
  const event = async (n: string) => (await admin.query<{ id: string }>("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('restore', $1, 1, 'restore.requested', '{}') RETURNING id::text AS id", [n])).rows[0]!.id;
  const row = async (id: string) => (await admin.query<{ state: string; fencing_token: string; last_error: string | null; attempt: number }>('SELECT state, fencing_token, last_error, attempt FROM trustwork.job WHERE id = $1', [id])).rows[0]!;
  const receipt = (id: string, reference: string): ProviderReceipt => ({ effectKey: `job:${id}`, kind: 'restore.external', reference, at: new Date().toISOString() });
  const journal = (receipts: ProviderReceipt[]) => {
    const path = join(dir, `${randomUUID()}.jsonl`);
    writeFileSync(path, receipts.map((r) => JSON.stringify(r)).join('\n'));
    return path;
  };
  const fence = new RoleFence(admin, [env.workerLoginRole]);
  // Applying the fence terminates the worker login's sessions; idle pool clients report that as an 'error' event.
  const workerPool = (max: number) => {
    const pool = env.workerPool(max);
    pool.on('error', () => undefined);
    return pool;
  };
  const drain = async (worker: Worker) => {
    for (let i = 0; i < 4; i++) {
      await worker.runOnce();
      await worker.idle();
    }
  };

  // The state a restore brings back: work the lost primary may or may not have finished.
  const doneAfterPoint = await job('restore.external', 'queued');        // its effect happened after the recovery point
  const untouched = await job('restore.external', 'queued');             // never ran
  const lostLease = await job('restore.external', 'leased');             // leased by the lost primary, no effect
  const lostTxLease = await job('restore.tx', 'leased');                 // database-only work, rolled back with the primary
  const parkedBefore = await job('restore.external', 'outcome_unknown', 'lease expired; awaiting reconciliation');
  const pending = await event('pending-1');
  const orphan = randomUUID();                                            // a job the restored database never saw
  const restoreStartedAt = new Date();

  await t.test('fence: the worker login is refused and a real worker leases nothing and calls no provider', async () => {
    await fence.apply();
    assert.ok(await fence.isApplied());
    await assert.rejects(new pg.Client({ connectionString: env.workerUrl }).connect(), (e: { code?: string }) => e.code === '28000');
    const worker = new Worker({ pool: workerPool(2), registry: registry(), config: { workerId: 'fenced', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    const report = await worker.runOnce();
    assert.deepEqual([report.leased, report.relayed, calls.length], [0, 0, 0]);
    assert.ok(report.errors >= 2);
  });

  await t.test('negative authorization: runtime logins can neither reconcile, decide, authorize nor lift the fence', async () => {
    // The worker login cannot even connect (fenced); the API login connects but cannot become the owner.
    {
      const pool = env.apiPool as unknown as pg.Pool;
      await assert.rejects(reconcileRestore({ admin: pool, restoreId: 'r-neg', recoveryPoint: new Date(), restoreStartedAt, journal: { receipts: [], completeThrough: new Date() }, operator: 'x' }), (e: { code?: string }) => e.code === '42501');
      await assert.rejects(resolveOutboxEvent({ admin: pool, restoreId: 'r-neg', eventId: pending, decision: 'delivered', reference: 'x', operator: 'x' }), (e: { code?: string }) => e.code === '42501');
      await assert.rejects(authorizeRestore({ admin: pool, fence, restoreId: 'r-neg', reference: 'x', operator: 'x' }), (e: { code?: string }) => e.code === '42501');
      await assert.rejects(new RoleFence(pool, [env.workerLoginRole]).lift(), (e: { code?: string }) => e.code === '42501');
    }
    assert.ok(await fence.isApplied(), 'still fenced');
    assert.equal((await row(doneAfterPoint)).state, 'queued', 'nothing changed');
  });

  await t.test('authorization is refused before reconciliation', async () => {
    await assert.rejects(authorizeRestore({ admin, fence, restoreId: 'r1', reference: 'ticket-1', operator: 'operator', privacyLedger }), (e) => e instanceof AuthorizationRefused && /not been reconciled/.test(e.message));
    assert.ok(await fence.isApplied());
  });

  await t.test('reconciliation with a complete receipt journal (two operators at once)', async () => {
    const before = await row(lostLease);
    const loaded = await readReceiptJournal(journal([receipt(doneAfterPoint, 'msg-1'), receipt(orphan, 'msg-2')]), new Date());
    const input = { admin, restoreId: 'r1', recoveryPoint: new Date(restoreStartedAt.getTime() - 60_000), restoreStartedAt, journal: loaded, operator: 'operator', modes: MODES };
    const [a, b] = await Promise.all([reconcileRestore(input), reconcileRestore(input)]);
    const closed = [...a.jobs.closedByReceipt, ...b.jobs.closedByReceipt];
    assert.deepEqual(closed.map((j) => [j.id, j.reference]), [[doneAfterPoint, 'msg-1']], 'closed exactly once although two runs raced');
    const first = a.jobs.closedByReceipt.length ? a : b;
    assert.deepEqual(first.jobs.releasedToQueue.map((j) => j.id).sort(), [lostLease, lostTxLease].sort());
    assert.deepEqual(first.jobs.keptQueued.map((j) => j.id), [untouched]);
    assert.deepEqual(first.jobs.alreadyParked.map((j) => j.id), [parkedBefore]);
    assert.deepEqual(first.orphanReceipts.map((r) => r.reference), ['msg-2']);
    assert.deepEqual([first.pendingOutbox.map((e) => e.id), first.ambiguousOutbox], [[pending], [pending]]);
    assert.equal((await row(doneAfterPoint)).state, 'succeeded');
    const released = await row(lostLease);
    assert.equal(released.state, 'queued');
    assert.ok(BigInt(released.fencing_token) > BigInt(before.fencing_token), 'fencing token bumped');
    assert.equal(released.attempt, 0, 'the lost attempt is not counted');
    const lostHolderCompletes = await tx(admin as never, (trx) => jobs.complete(trx, lostLease, before.fencing_token));
    assert.equal(lostHolderCompletes, false, 'the lost primary cannot complete its stale lease');
    assert.equal((await row(parkedBefore)).state, 'outcome_unknown', 'jobs parked before the failure stay parked for the worker reconcile CLI');
    const audited = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'job.reconciled' AND object_id = $1", [doneAfterPoint])).rows[0]!.n;
    assert.equal(audited, 1);
  });

  await t.test('an ambiguous pending event blocks authorization until an operator decides', async () => {
    await assert.rejects(authorizeRestore({ admin, fence, restoreId: 'r1', reference: 'ticket-1', operator: 'operator', privacyLedger }), (e) => e instanceof AuthorizationRefused && e.message.includes(pending));
    assert.ok(await fence.isApplied(), 'a refused authorization leaves the fence in place');
    await assert.rejects(resolveOutboxEvent({ admin, restoreId: 'r1', eventId: '999999', decision: 'relay', reference: 'x', operator: 'operator' }), /not found/);
    await assert.rejects(resolveOutboxEvent({ admin, restoreId: 'r1', eventId: pending, decision: 'maybe' as never, reference: 'x', operator: 'operator' }), /delivered or relay/);
    await resolveOutboxEvent({ admin, restoreId: 'r1', eventId: pending, decision: 'relay', reference: 'provider log has no message for pending-1', operator: 'operator' });
    const { authorizedAt } = await authorizeRestore({ admin, fence, restoreId: 'r1', reference: 'ticket-1', operator: 'operator', privacyLedger });
    assert.ok(Date.parse(authorizedAt) > 0);
    assert.equal(await fence.isApplied(), false);
  });

  await t.test('after authorization the real worker runs approved work once and never repeats a delivered effect', async () => {
    const worker = new Worker({ pool: workerPool(4), registry: registry(), config: { workerId: 'restored', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    await drain(worker);
    const relayed = (await admin.query<{ id: string }>("SELECT id FROM trustwork.job WHERE payload->>'eventId' = $1", [pending])).rows.map((r) => r.id);
    assert.equal(relayed.length, 1, 'the approved event was relayed once');
    assert.deepEqual(calls.sort(), [`job:${untouched}`, `job:${lostLease}`, `job:${relayed[0]}`].sort());
    assert.ok(!calls.includes(`job:${doneAfterPoint}`), 'the effect that already happened is never sent again');
    assert.ok(!calls.includes(`job:${parkedBefore}`), 'a parked job is never leased');
    assert.equal((await row(lostTxLease)).state, 'succeeded', 'database-only work simply re-ran');
  });

  await t.test('incomplete journal: unknown outcomes are parked, closed later by a receipt; a delivered event is never relayed', async () => {
    calls.length = 0;
    const unknown = await job('restore.external', 'queued');
    const delivered = await event('pending-2');
    await fence.apply();
    const startedAt = new Date();
    const report = await reconcileRestore({ admin, restoreId: 'r2', recoveryPoint: new Date(startedAt.getTime() - 60_000), restoreStartedAt: startedAt, journal: { receipts: [], completeThrough: null }, operator: 'operator', modes: MODES });
    assert.equal(report.journalComplete, false);
    assert.deepEqual(report.jobs.parked.map((j) => j.id), [unknown]);
    assert.deepEqual(report.ambiguousOutbox, [delivered], 'without a complete journal every pending event needs a decision');
    const parked = await row(unknown);
    assert.equal(parked.state, 'outcome_unknown');
    assert.match(parked.last_error ?? '', /^restored:/);
    // The provider export arrives later and shows the effect: the restore-parked job closes by its receipt.
    const later = await reconcileRestore({ admin, restoreId: 'r2', recoveryPoint: new Date(startedAt.getTime() - 60_000), restoreStartedAt: startedAt, journal: { receipts: [receipt(unknown, 'msg-9')], completeThrough: null }, operator: 'operator', modes: MODES });
    assert.deepEqual(later.jobs.closedByReceipt.map((j) => j.id), [unknown]);
    assert.equal((await row(unknown)).state, 'succeeded');
    await resolveOutboxEvent({ admin, restoreId: 'r2', eventId: delivered, decision: 'delivered', reference: 'msg-8', operator: 'operator' });
    await assert.rejects(resolveOutboxEvent({ admin, restoreId: 'r2', eventId: delivered, decision: 'relay', reference: 'x', operator: 'operator' }), /already published/);
    await authorizeRestore({ admin, fence, restoreId: 'r2', reference: 'ticket-2', operator: 'operator', privacyLedger });
    const worker = new Worker({ pool: workerPool(2), registry: registry(), config: { workerId: 'restored-2', leaseSeconds: 30, retryJitter: 0 }, tasks: () => [] });
    await drain(worker);
    assert.deepEqual(calls, [], 'nothing was sent again');
    assert.equal((await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.job WHERE payload->>'eventId' = $1", [delivered])).rows[0]!.n, 0);
    const trail = (await admin.query<{ action: string }>("SELECT action FROM trustwork.audit_event WHERE object_kind IN ('restore', 'outbox_event') AND (object_id = 'r2' OR basis->>'restoreId' = 'r2') ORDER BY id")).rows.map((r) => r.action);
    assert.deepEqual(trail, ['restore.reconciled', 'restore.reconciled', 'restore.outbox_delivered', 'restore.authorized']);
  });
});
