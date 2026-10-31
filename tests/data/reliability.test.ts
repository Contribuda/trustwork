import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { bindTransaction, idempotency, inbox, jobs, outbox, withMaintenance, type Transaction } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, sqlState } from './helpers/postgres.js';

const db = await provisionTestDatabase('reliability');

test('outbox, job leases, idempotency, inbox and the frozen-row trigger', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();

  /** Reliability tables carry no party data, so the runtime role uses plain transactions without a principal. */
  const inTransaction = async <T>(pool: pg.Pool, fn: (trx: Transaction, client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    let failed = false;
    try {
      await client.query('BEGIN');
      const result = await fn(bindTransaction(client), client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      failed = true;
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release(failed ? true : undefined);
    }
  };

  await t.test('the runtime (API) role appends outbox events but cannot read, publish or delete them', async () => {
    // Claiming and publishing moved to the worker role (REL-001); tests/worker covers the relay with SKIP LOCKED.
    await inTransaction(db.app, async (trx) => {
      await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: 'm-1', revision: 1, type: 'membership.activated', payload: { personId: 'p' } });
      await outbox.append(trx, { aggregate_kind: 'membership', aggregate_id: 'm-1', revision: 2, type: 'membership.ended', payload: { personId: 'p' } });
    });
    const stored = await db.admin.query<{ type: string; revision: number }>('SELECT type, revision FROM trustwork.outbox_event ORDER BY id');
    assert.deepEqual(stored.rows.map((e) => [e.type, e.revision]), [['membership.activated', 1], ['membership.ended', 2]]);
    await assert.rejects(inTransaction(db.app, (trx) => outbox.claimUnpublished(trx, 10)), (e: unknown) => sqlState(e) === '42501');
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('outbox_event').set({ published_at: new Date() }).execute()), (e: unknown) => sqlState(e) === '42501');
    await assert.rejects(inTransaction(db.app, (trx) => trx.deleteFrom('outbox_event').execute()), (e: unknown) => sqlState(e) === '42501');
  });

  await t.test('job lease uses SKIP LOCKED and a fencing token that invalidates stale workers', async () => {
    await inTransaction(db.app, async (trx) => {
      for (const n of [1, 2, 3]) await jobs.enqueue(trx, { kind: 'embed', payload: { n }, max_attempts: 2 });
      await jobs.enqueue(trx, { kind: 'later', next_at: new Date(Date.now() + 3_600_000) });
    });
    const a = await db.app.connect();
    const b = await db.app.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      const leasedA = await jobs.lease(bindTransaction(a), ['embed', 'later'], 'worker-a', 30, 2);
      const leasedB = await jobs.lease(bindTransaction(b), ['embed', 'later'], 'worker-b', 30, 5);
      assert.equal(leasedA.length, 2);
      assert.equal(leasedB.length, 1, 'the second worker skips rows locked by the first and gets the remainder');
      assert.equal(new Set([...leasedA, ...leasedB].map((j) => j.id)).size, 3);
      assert.ok([...leasedA, ...leasedB].every((j) => j.state === 'leased' && j.fencing_token === '1' && j.attempt === 1 && j.kind === 'embed'));
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
    const [job] = await inTransaction(db.app, (trx) => trx.selectFrom('job').selectAll().where('kind', '=', 'embed').orderBy('id').limit(1).execute());
    assert.ok(job);
    // Reconciliation stand-in: an expired lease is explicitly re-queued by the maintenance identity, never by lease_jobs.
    await withMaintenance(db.admin, (trx) => trx.updateTable('job').set({ state: 'queued', leased_until: null, leased_by: null, next_at: new Date() }).where('id', '=', job.id).execute());
    assert.deepEqual(await inTransaction(db.app, (trx) => jobs.lease(trx, ['embed'], 'worker-c', 30, 5)).then((r) => r.map((j) => [j.id, j.fencing_token, j.attempt])), [[job.id, '2', 2]]);
    assert.equal(await inTransaction(db.app, (trx) => jobs.complete(trx, job.id, 1)), false, 'the stale worker is fenced out');
    assert.equal(await inTransaction(db.app, (trx) => jobs.heartbeat(trx, job.id, 1, 30)), false);
    assert.equal(await inTransaction(db.app, (trx) => jobs.heartbeat(trx, job.id, 2, 30)), true);
    assert.equal(await inTransaction(db.app, (trx) => jobs.complete(trx, job.id, 2)), true);
    assert.equal((await inTransaction(db.app, (trx) => jobs.getById(trx, job.id)))?.state, 'succeeded');
    assert.equal(await inTransaction(db.app, (trx) => jobs.complete(trx, job.id, 2)), false, 'completion is not repeatable');

    const others = await inTransaction(db.app, (trx) => trx.selectFrom('job').select(['id', 'fencing_token']).where('kind', '=', 'embed').where('state', '=', 'leased').execute());
    assert.equal(others.length, 2);
    const victim = others[0]!;
    assert.equal(await inTransaction(db.app, (trx) => jobs.fail(trx, victim.id, victim.fencing_token, 'pre-effect failure', new Date())), true);
    assert.equal((await inTransaction(db.app, (trx) => jobs.getById(trx, victim.id)))?.state, 'queued', 'first failure re-queues (max_attempts 2)');
    const again = await inTransaction(db.app, (trx) => jobs.lease(trx, ['embed'], 'worker-d', 30, 5));
    assert.deepEqual(again.map((j) => [j.id, j.attempt, j.fencing_token]), [[victim.id, 2, '2']]);
    assert.equal(await inTransaction(db.app, (trx) => jobs.fail(trx, victim.id, 2, 'failed again', new Date())), true);
    assert.equal((await inTransaction(db.app, (trx) => jobs.getById(trx, victim.id)))?.state, 'dead', 'attempts exhausted: dead-letter, not silent retry');
    const unknown = others[1]!;
    assert.equal(await inTransaction(db.app, (trx) => jobs.markOutcomeUnknown(trx, unknown.id, unknown.fencing_token, 'timeout after dispatch')), true);
    assert.deepEqual(await inTransaction(db.app, (trx) => jobs.lease(trx, ['embed'], 'worker-e', 30, 5)), [], 'outcome_unknown and dead jobs are never re-leased');
    await assert.rejects(inTransaction(db.app, (trx) => trx.insertInto('job').values({ kind: 'x', state: 'leased' }).execute()), (e: unknown) => sqlState(e) === '23514');
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('job').set({ fencing_token: '99' }).where('id', '=', job.id).execute()), (e: unknown) => sqlState(e) === '42501', 'the runtime role cannot move the fencing token');
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('job').set({ attempt: 0 }).where('id', '=', job.id).execute()), (e: unknown) => sqlState(e) === '42501');
  });

  await t.test('expired leases are parked as outcome_unknown for reconciliation, never re-leased', async () => {
    const queued = await inTransaction(db.app, (trx) => jobs.enqueue(trx, { kind: 'dispatch' }));
    const [leased] = await inTransaction(db.app, (trx) => jobs.lease(trx, ['dispatch'], 'worker-x', 1, 1));
    assert.equal(leased?.id, queued.id);
    assert.deepEqual(await inTransaction(db.app, (trx) => jobs.expireLeases(trx, new Date())), [], 'a live lease is untouched');
    const expired = await inTransaction(db.app, (trx) => jobs.expireLeases(trx, new Date(Date.now() + 5_000)));
    assert.deepEqual(expired.map((j) => [j.id, j.state, j.leased_by, j.fencing_token]), [[queued.id, 'outcome_unknown', null, '1']]);
    assert.equal(await inTransaction(db.app, (trx) => jobs.complete(trx, queued.id, 1)), false, 'the old worker cannot complete a parked job');
    assert.deepEqual(await inTransaction(db.app, (trx) => jobs.lease(trx, ['dispatch'], 'worker-y', 30, 5)), [], 'reconciliation is an explicit command, not a replay');
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('job').set({ state: 'queued' }).where('id', '=', queued.id).execute()), (e: unknown) => sqlState(e) === '23000' && /reconciliation/.test(String(e)), 'parked jobs cannot be re-queued directly');
    await assert.rejects(inTransaction(db.app, (trx) => jobs.reconcile(trx, queued.id, 'queued', '')), (e: unknown) => sqlState(e) === '23000' && /reference/.test(String(e)));
    const reconciled = await inTransaction(db.app, (trx) => jobs.reconcile(trx, queued.id, 'queued', 'reconciliation-1'));
    assert.equal(reconciled.state, 'queued');
    assert.deepEqual(await inTransaction(db.app, (trx) => jobs.lease(trx, ['dispatch'], 'worker-y', 30, 5)).then((r) => r.map((j) => [j.id, j.fencing_token])), [[queued.id, '2']]);
    await assert.rejects(inTransaction(db.app, (trx) => jobs.reconcile(trx, queued.id, 'succeeded', 'reconciliation-2')), (e: unknown) => sqlState(e) === '23000' && /not awaiting/.test(String(e)));
    const done = (await inTransaction(db.app, (trx) => jobs.complete(trx, queued.id, 2)));
    assert.equal(done, true);
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('job').set({ state: 'queued' }).where('id', '=', queued.id).execute()), (e: unknown) => sqlState(e) === '23000', 'terminal states are final for the runtime role');
  });

  await t.test('invariant 4: idempotency records are unique per (principal, action, context, key) with a payload digest', async () => {
    const scope = { principalId: 'person-1', action: 'projects.create', contextId: 'company-1', key: 'k-1' };
    const digest = 'a'.repeat(64);
    const record = await inTransaction(db.app, (trx) => idempotency.begin(trx, scope, digest, new Date(Date.now() + 60_000)));
    assert.equal(record.state, 'in_progress');
    await assert.rejects(inTransaction(db.app, (trx) => idempotency.begin(trx, scope, 'b'.repeat(64), new Date())), (e: unknown) => sqlState(e) === '23505' && /idempotency_scope_unique/.test(String(e)));
    await inTransaction(db.app, (trx) => idempotency.begin(trx, { ...scope, principalId: 'person-2' }, digest, new Date()));
    await inTransaction(db.app, (trx) => idempotency.begin(trx, { ...scope, contextId: 'company-2' }, digest, new Date()));
    const stored = await inTransaction(db.app, (trx) => idempotency.get(trx, scope));
    assert.equal(stored?.payload_digest, digest, 'the caller compares the digest and answers validation.idempotency_conflict on mismatch');
    const completed = await inTransaction(db.app, (trx) => idempotency.complete(trx, record.id, { actionId: 'a-1', state: 'queued' }));
    assert.deepEqual(completed?.result, { actionId: 'a-1', state: 'queued' });
    assert.equal(await inTransaction(db.app, (trx) => idempotency.complete(trx, record.id, { again: true })), undefined, 'completion is recorded once');
    await assert.rejects(inTransaction(db.app, (trx) => trx.updateTable('idempotency_record').set({ state: 'completed', result: null }).where('id', '=', record.id).execute()), (e: unknown) => sqlState(e) === '23514');
  });

  await t.test('invariant 4: inbound receipts are deduplicated by (provider, account, event_id)', async () => {
    const first = await inTransaction(db.app, (trx) => inbox.record(trx, { provider: 'mail', account: 'acct-1', event_id: 'evt-1' }));
    const second = await inTransaction(db.app, (trx) => inbox.record(trx, { provider: 'mail', account: 'acct-1', event_id: 'evt-1' }));
    const otherAccount = await inTransaction(db.app, (trx) => inbox.record(trx, { provider: 'mail', account: 'acct-2', event_id: 'evt-1' }));
    assert.equal(first.fresh, true);
    assert.equal(second.fresh, false);
    assert.equal(second.receipt?.id, first.receipt?.id);
    assert.equal(otherAccount.fresh, true);
  });

  await t.test('reject_update_when_frozen is reusable: frozen columns lock once the status leaves draft', async () => {
    await db.admin.query(`CREATE TABLE trustwork.frozen_probe (id serial PRIMARY KEY, status text NOT NULL DEFAULT 'draft', payload jsonb NOT NULL, digest text NULL, rfq_version_id uuid NULL, note text NULL);
      CREATE TRIGGER frozen_probe_guard BEFORE UPDATE ON trustwork.frozen_probe FOR EACH ROW EXECUTE FUNCTION trustwork.reject_update_when_frozen('status', 'draft', 'payload', 'digest', 'rfq_version_id');`);
    await db.admin.query("INSERT INTO trustwork.frozen_probe (payload) VALUES ('{\"qty\": 10}')");
    await db.admin.query("UPDATE trustwork.frozen_probe SET payload = '{\"qty\": 20}' WHERE id = 1");
    await db.admin.query("UPDATE trustwork.frozen_probe SET status = 'published', payload = '{\"qty\": 30}', digest = 'd1' WHERE id = 1");
    const frozen = async (statement: string, pattern: RegExp) => {
      const error = await db.admin.query(statement).then(() => null, (e: unknown) => e);
      assert.equal(sqlState(error), '23000', statement);
      assert.match(String((error as Error).message), pattern);
      assert.equal((error as { hint?: string }).hint, 'commercial.version_frozen');
    };
    await frozen("UPDATE trustwork.frozen_probe SET payload = '{\"qty\": 40}' WHERE id = 1", /column payload .* is frozen/);
    await frozen("UPDATE trustwork.frozen_probe SET digest = 'd2' WHERE id = 1", /column digest .* is frozen/);
    await frozen("UPDATE trustwork.frozen_probe SET rfq_version_id = '11111111-1111-4111-8111-111111111111' WHERE id = 1", /column rfq_version_id .* is frozen/);
    await frozen("UPDATE trustwork.frozen_probe SET status = 'draft' WHERE id = 1", /cannot return to status draft/);
    await db.admin.query("UPDATE trustwork.frozen_probe SET note = 'annotations stay editable', status = 'superseded' WHERE id = 1");
    const row = await db.admin.query<{ status: string; payload: { qty: number }; note: string }>('SELECT status, payload, note FROM trustwork.frozen_probe WHERE id = 1');
    assert.deepEqual(row.rows[0], { status: 'superseded', payload: { qty: 30 }, note: 'annotations stay editable' });
    await db.admin.query('DROP TABLE trustwork.frozen_probe');
  });
});
