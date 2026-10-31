import test from 'node:test';
import assert from 'node:assert/strict';
import { expectError, SKIP_REASON, startHarness, type Client } from '../helpers/app.js';
import { EMAILS, login, seedPersonas } from '../helpers/personas.js';
import { auditCount, count, installAuditFault } from '../hardening/helpers.js';
import { IDEMPOTENCY_TAKEOVER_LEASE_MS, IDEMPOTENT_ROUTES } from '../../../apps/api/src/common/idempotency/index.js';
import { HOLD_LOCK, installCrashPoints, lockWaiters, recordState, until } from './helpers.js';

const h = await startHarness('idem_concurrency');

/**
 * BE-005 concurrency on real PostgreSQL: concurrent retries of one key produce exactly one effect; a takeover never
 * lets two executions commit (the lease is a fence); a takeover that loses to a committing execution replays its
 * result. Also keeps the BE-002 guarantees (injected clock, bounded wait, single re-execution of a recorded 5xx) and
 * the documented lease behaviour of the routes that cannot complete in their transaction.
 */
test('exactly-once completion under concurrency, fencing and the lease routes', { skip: h ? false : SKIP_REASON }, async (t) => {
  if (!h) return;
  t.after(() => h.close());
  const seed = await seedPersonas(h);
  const crash = await installCrashPoints(h.db.admin);
  const client: Client = h.client();
  await login(client, 'petr');
  const body = (name: string) => ({ owner: { kind: 'person', id: seed.people.petr }, name, summary: null, leaderPersonId: null });
  const projects = (name: string) => count(h.db.admin, 'SELECT 1 FROM trustwork.project WHERE name = $1', [name]);
  t.afterEach(async () => {
    await crash.clear();
    h.clock.reset();
  });

  await t.test('the lease and the retention come from the injected clock', async () => {
    h.clock.advance(10 * 60_000); // inside the idle window; far enough from the host clock to tell them apart
    const before = h.clock.now().getTime();
    assert.equal((await client.post('/v1/projects', body('Clock project'), { idempotencyKey: 'clock-1' })).status, 201);
    const row = await recordState(h.db.admin, 'clock-1');
    assert.equal(row?.state, 'completed');
    const retention = h.created.config.idempotency.retentionMs;
    assert.ok(Math.abs((row?.expires_at.getTime() ?? 0) - (before + retention)) < 60_000, 'retention measured from the injected clock, not the host clock');
  });

  await t.test('concurrent first requests with one key: exactly one effect, every success is the same response', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => client.post('/v1/projects', body('Burst project'), { idempotencyKey: 'burst-1' })));
    const statuses = results.map((r) => r.status);
    assert.ok(statuses.every((s) => s === 201 || s === 409), JSON.stringify(statuses));
    for (const r of results.filter((r) => r.status === 409)) expectError(r, 409, 'validation.idempotency_in_progress');
    assert.equal(await projects('Burst project'), 1, JSON.stringify({ statuses, record: await recordState(h.db.admin, 'burst-1') }));
    assert.equal(new Set(results.filter((r) => r.status === 201).map((r) => (r.body as { id: string }).id)).size, 1);
    const replay = await client.post('/v1/projects', body('Burst project'), { idempotencyKey: 'burst-1' });
    assert.equal(replay.status, 201);
    assert.equal(await projects('Burst project'), 1);
  });

  await t.test('concurrent retries after a crash before COMMIT: exactly one takeover, one effect', async () => {
    await crash.arm('handler', 'bookkeeping');
    assert.equal((await client.post('/v1/projects', body('Race project'), { idempotencyKey: 'race-1' })).status, 500);
    assert.equal((await recordState(h.db.admin, 'race-1'))?.state, 'in_progress');
    assert.equal(await projects('Race project'), 0);
    await crash.disarm('handler');
    const blocked = await client.post('/v1/projects', body('Race project'), { idempotencyKey: 'race-1' });
    expectError(blocked, 409, 'validation.idempotency_in_progress');
    const retryAfter = (blocked.body as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds;
    assert.ok(retryAfter > 0 && retryAfter <= IDEMPOTENCY_TAKEOVER_LEASE_MS / 1000, `retry after ${retryAfter}s`);
    h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => client.post('/v1/projects', body('Race project'), { idempotencyKey: 'race-1' })));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status)));
    assert.equal(await projects('Race project'), 1, 'exactly one effect');
    const created = results.filter((r) => r.status === 201).map((r) => JSON.stringify(r.body));
    assert.ok(created.length >= 1);
    assert.equal(new Set(results.filter((r) => r.status === 201).map((r) => (r.body as { id: string }).id)).size, 1, 'every 201 is the single winner or its replay');
    h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
    const replay = await client.post('/v1/projects', body('Race project'), { idempotencyKey: 'race-1' });
    assert.deepEqual(replay.body, JSON.parse(created[0]!));
    assert.equal(await projects('Race project'), 1);
  });

  await t.test('fence: an execution slower than the lease is rolled back once a retry took the record over', async () => {
    const blocker = await h.db.admin.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE trustwork.audit_event IN SHARE MODE'); // every handler blocks at its audit write
      const original = client.post('/v1/projects', body('Slow project'), { idempotencyKey: 'slow-1' });
      await until(async () => (await lockWaiters(h.db.admin)) >= 1, 'the original execution to block');
      const lease = (await recordState(h.db.admin, 'slow-1'))?.expires_at.getTime();
      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
      const retry = client.post('/v1/projects', body('Slow project'), { idempotencyKey: 'slow-1' });
      await until(async () => (await recordState(h.db.admin, 'slow-1'))?.expires_at.getTime() !== lease && (await lockWaiters(h.db.admin)) >= 2, 'the retry to take over and block');
      await blocker.query('COMMIT');
      const [first, second] = await Promise.all([original, retry]);
      expectError(first, 409, 'validation.idempotency_in_progress');
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(await projects('Slow project'), 1, 'the late original did not commit a second effect');
      const replay = await client.post('/v1/projects', body('Slow project'), { idempotencyKey: 'slow-1' });
      assert.deepEqual(replay.body, second.body);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
    }
  });

  await t.test('a takeover that waits on a committing execution replays its result instead of re-running', async () => {
    const holder = await h.db.admin.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [HOLD_LOCK]);
      await crash.arm('hold'); // the original stops between its in-transaction completion write and COMMIT
      const audits = await auditCount(h.db.admin, 'project.created');
      const original = client.post('/v1/projects', body('Held project'), { idempotencyKey: 'held-1' });
      await until(async () => (await lockWaiters(h.db.admin)) >= 1, 'the original to hold its completion');
      h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
      const retry = client.post('/v1/projects', body('Held project'), { idempotencyKey: 'held-1' });
      await until(async () => (await lockWaiters(h.db.admin)) >= 2, 'the takeover to wait on the record');
      await holder.query('SELECT pg_advisory_unlock($1)', [HOLD_LOCK]);
      const [first, second] = await Promise.all([original, retry]);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual(second.body, first.body, 'the takeover returned the committed response');
      assert.equal(await projects('Held project'), 1);
      assert.equal(await auditCount(h.db.admin, 'project.created'), audits + 1, 'the handler ran once');
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
      holder.release();
    }
  });

  await t.test('lease route (membership.invite): a crash after COMMIT is re-run after the lease, as documented', async () => {
    assert.equal(IDEMPOTENT_ROUTES['membership.invite']?.kind, 'lease');
    const carl = h.client();
    await login(carl, 'carl');
    const company = seed.companies.unrelated;
    const invite = { companyId: company, inviteeEmail: EMAILS.xenia, role: 'member', permissions: [] };
    const send = () => carl.post(`/v1/companies/${company}/memberships`, invite, { idempotencyKey: 'invite-1' });
    const invitations = () => count(h.db.admin, 'SELECT 1 FROM trustwork.membership WHERE person_id = $1 AND company_id = $2', [seed.people.xenia, company]);
    await crash.arm('bookkeeping');
    assert.equal((await send()).status, 202);
    assert.equal((await recordState(h.db.admin, 'invite-1'))?.state, 'in_progress', 'the bookkeeping after COMMIT was lost');
    assert.equal(await h.mail.countTo(EMAILS.xenia, 'membership_invitation'), 1);
    await crash.disarm('bookkeeping');
    expectError(await send(), 409, 'validation.idempotency_in_progress');
    h.clock.advance(IDEMPOTENCY_TAKEOVER_LEASE_MS + 1_000);
    assert.equal((await send()).status, 202);
    assert.equal(await h.mail.countTo(EMAILS.xenia, 'membership_invitation'), 2, 'the takeover re-sent the invitation (documented)');
    assert.equal(await invitations(), 1, 'the pending invitation is re-sent, not duplicated');
    assert.equal((await send()).status, 202);
    assert.equal(await h.mail.countTo(EMAILS.xenia, 'membership_invitation'), 2, 'later retries replay');
  });

  await t.test('a recorded 5xx is re-executed by exactly one retry', async () => {
    const fault = await installAuditFault(h.db.admin);
    await fault.fail('project.created');
    const failed = await client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' });
    assert.equal(failed.status, 500);
    assert.equal(await projects('Flaky project'), 0);
    await fault.clear();
    const results = await Promise.all(Array.from({ length: 4 }, () => client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' })));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), JSON.stringify(results.map((r) => r.status)));
    assert.equal(await projects('Flaky project'), 1, 'one re-execution');
    assert.equal((await client.post('/v1/projects', body('Flaky project'), { idempotencyKey: 'flaky-1' })).status, 201);
  });
});
