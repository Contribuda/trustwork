import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness, type Client } from '../helpers/app.js';
import { login, seedPersonas } from '../helpers/personas.js';
import { count, installAuditFault } from './helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS } from '../../../apps/api/src/common/idempotency.interceptor.js';

const h = await startHarness('hardening_idem');

/**
 * BE-002 acceptance: "A crash between handler commit and bookkeeping does not block the user's retry for longer than
 * the takeover lease." The crash is simulated on real PostgreSQL: a trigger makes the bookkeeping write (in_progress
 * -> completed) fail after the handler committed, which leaves the record exactly as a process death would.
 */
test('idempotency records: takeover lease after a lost completion, single winner, injected clock', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const client: Client = h.client();
  await login(client, 'petr');
  await h.db.admin.query('CREATE TABLE public.test_idempotency_crash (on_key text PRIMARY KEY)');
  await h.db.admin.query(`CREATE FUNCTION public.test_idempotency_crash() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    BEGIN
      IF OLD.state = 'in_progress' AND NEW.state = 'completed' AND EXISTS (SELECT 1 FROM public.test_idempotency_crash c WHERE c.on_key = NEW.key) THEN
        RAISE EXCEPTION 'simulated crash before bookkeeping' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END $$`);
  await h.db.admin.query('CREATE TRIGGER test_idempotency_crash BEFORE UPDATE ON trustwork.idempotency_record FOR EACH ROW EXECUTE FUNCTION public.test_idempotency_crash()');
  const crashOn = (key: string) => h.db.admin.query('INSERT INTO public.test_idempotency_crash VALUES ($1)', [key]);
  const recover = () => h.db.admin.query('DELETE FROM public.test_idempotency_crash');
  const body = (name: string) => ({ owner: { kind: 'person', id: seed.people.petr }, name, summary: null, leaderPersonId: null });
  const projects = (name: string) => count(h.db.admin, 'SELECT 1 FROM trustwork.project WHERE name = $1', [name]);
  const record = async (key: string) => (await h.db.admin.query<{ state: string; expires_at: Date }>('SELECT state, expires_at FROM trustwork.idempotency_record WHERE key = $1', [key])).rows[0];
  t.afterEach(() => { h.clock.reset(); });

  await t.test('the lease and the retention come from the injected clock', async () => {
    h.clock.advance(10 * 60_000); // inside the idle window; far enough from the host clock to tell them apart
    const before = h.clock.now().getTime();
    assert.equal((await client.post('/v1/projects', body('Clock project'), { idempotencyKey: 'clock-1' })).status, 201);
    const row = await record('clock-1');
    assert.equal(row?.state, 'completed');
    const retention = h.created.config.idempotency.retentionMs;
    assert.ok(Math.abs((row?.expires_at.getTime() ?? 0) - (before + retention)) < 60_000, 'retention measured from the injected clock, not the host clock');
  });

  await t.test('a lost completion blocks the retry only until the takeover lease passes', async () => {
    await crashOn('crash-1');
    const first = await client.post('/v1/projects', body('Crash project'), { idempotencyKey: 'crash-1' });
    assert.equal(first.status, 201, 'the handler committed; only the bookkeeping was lost');
    assert.equal((await record('crash-1'))?.state, 'in_progress');
    await recover();
    const blocked = await client.post('/v1/projects', body('Crash project'), { idempotencyKey: 'crash-1' });
    expectError(blocked, 409, 'validation.idempotency_in_progress');
    const retryAfter = (blocked.body as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    assert.ok(retryAfter > 0 && retryAfter <= IDEMPOTENCY_TAKEOVER_LEASE_MS / 1000, `retry after ${retryAfter}s`);
    h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS - 2_000);
    expectError(await client.post('/v1/projects', body('Crash project'), { idempotencyKey: 'crash-1' }), 409, 'validation.idempotency_in_progress');
    h.clock.advance(3_000);
    const takeover = await client.post('/v1/projects', body('Crash project'), { idempotencyKey: 'crash-1' });
    assert.equal(takeover.status, 201, JSON.stringify(takeover.body));
    assert.equal((await record('crash-1'))?.state, 'completed');
    const replay = await client.post('/v1/projects', body('Crash project'), { idempotencyKey: 'crash-1' });
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, takeover.body, 'later retries replay the takeover result');
    expectError(await client.post('/v1/projects', body('Other payload'), { idempotencyKey: 'crash-1' }), 409, 'validation.idempotency_conflict');
    assert.equal(await projects('Crash project'), 2, 'the effect of the lost execution is not deduplicated (documented price of the lease)');
  });

  await t.test('concurrency: after the lease, exactly one of many simultaneous retries takes over', async () => {
    await crashOn('crash-2');
    assert.equal((await client.post('/v1/projects', body('Race project'), { idempotencyKey: 'crash-2' })).status, 201);
    await recover();
    h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => client.post('/v1/projects', body('Race project'), { idempotencyKey: 'crash-2' })));
    const statuses = results.map((r) => r.status);
    assert.ok(statuses.every((s) => s === 201 || s === 409), JSON.stringify(statuses));
    assert.equal(await projects('Race project'), 2, 'one original execution plus exactly one takeover');
    const created = results.filter((r) => r.status === 201).map((r) => JSON.stringify(r.body));
    assert.equal(new Set(created).size, 1, 'every 201 is the single winner or its replay');
  });

  await t.test('a recorded 5xx is re-executed by exactly one retry', async () => {
    const fault = await installAuditFault(h.db.admin);
    await fault.fail('project.created');
    const failed = await client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' });
    assert.equal(failed.status, 500);
    await fault.clear();
    const results = await Promise.all(Array.from({ length: 4 }, () => client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' })));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status)));
    assert.equal(await projects('Flaky project'), 1, 'one re-execution');
    assert.equal((await client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' })).status, 201);
  });
});
