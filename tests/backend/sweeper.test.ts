import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auth, createPool, maintenance, withMaintenance } from '@trustwork/data';
import { runSweep } from '../../apps/api/src/dev/sweep.js';
import { provisionTestDatabase, SKIP_REASON } from '../data/helpers/postgres.js';
import { seedFixtures } from '../data/helpers/seed.js';

const db = await provisionTestDatabase('sweeper');

test('bounded tables: sweeper and login_failure cap (review P2-3)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  const runtime = createPool({ ...db.appConfig, max: 4 });
  t.after(async () => { await runtime.end(); await db.close(); });
  const hex = (s: string) => createHash('sha256').update(s).digest('hex');

  await t.test('login_failure never exceeds 10,000 rows; the oldest rows are evicted', async () => {
    await withMaintenance(db.admin, async (trx) => {
      await trx.insertInto('login_failure').values(Array.from({ length: 10_000 }, (_, i) => ({ subject_hash: Buffer.from(hex(`old-${i}`), 'hex'), occurred_at: new Date(Date.now() - 3_600_000 + i), expires_at: new Date(Date.now() + 86_400_000) }))).execute();
    });
    await auth.recordLoginFailure(runtime, hex('fresh'), 900, 86_400);
    await auth.recordLoginFailure(runtime, hex('fresh'), 900, 86_400);
    const { rows } = await db.admin.query<{ n: number; fresh: number }>('SELECT count(*)::int AS n, count(*) FILTER (WHERE subject_hash = $1)::int AS fresh FROM trustwork.login_failure', [Buffer.from(hex('fresh'), 'hex')]);
    assert.equal(rows[0]?.n, 10_000);
    assert.equal(rows[0]?.fresh, 2, 'the newest rows survive, the oldest are evicted');
  });

  await t.test('sweep_expired deletes expired bookkeeping and never-verified signups, keeps live rows', async () => {
    const past = new Date(Date.now() - 2 * 86_400_000);
    const future = new Date(Date.now() + 86_400_000);
    const old = new Date(Date.now() - 8 * 86_400_000);
    await withMaintenance(db.admin, async (trx) => {
      await trx.insertInto('auth_token').values([
        { token_hash: Buffer.from(hex('t-expired'), 'hex'), kind: 'recovery', person_id: seed.people.pure, email_normalized: 'pure@example.invalid', expires_at: past },
        { token_hash: Buffer.from(hex('t-live'), 'hex'), kind: 'recovery', person_id: seed.people.pure, email_normalized: 'pure@example.invalid', expires_at: future },
      ]).execute();
      await trx.insertInto('idempotency_record').values([
        { principal_id: 'p', action: 'a', context_id: 'c', key: 'expired', payload_digest: hex('x'), expires_at: past },
        { principal_id: 'p', action: 'a', context_id: 'c', key: 'live', payload_digest: hex('x'), expires_at: future },
      ]).execute();
      await trx.insertInto('session').values([
        { person_id: seed.people.pure, token_hash: Buffer.from(hex('s-old'), 'hex'), idle_expires_at: old, absolute_expires_at: old, auth_method: 'password', created_at: new Date(Date.now() - 100 * 86_400_000), revoked_at: new Date(Date.now() - 100 * 86_400_000), revoked_reason: 'logout' },
        { person_id: seed.people.pure, token_hash: Buffer.from(hex('s-live'), 'hex'), idle_expires_at: future, absolute_expires_at: future, auth_method: 'password' },
      ]).execute();
      const stale = await trx.insertInto('person').values({ display_name: 'never verified', created_at: old }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('email_binding').values({ person_id: stale.id, email_normalized: 'stale@example.invalid', is_primary: true }).execute();
      await trx.insertInto('credential').values({ person_id: stale.id, kind: 'password', password_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA' }).execute();
      const recent = await trx.insertInto('person').values({ display_name: 'recent unverified' }).returning('id').executeTakeFirstOrThrow();
      await trx.insertInto('email_binding').values({ person_id: recent.id, email_normalized: 'recent@example.invalid', is_primary: true }).execute();
    });
    const report = await runSweep(runtime);
    assert.equal(report.auth_tokens, 1);
    assert.equal(report.idempotency_records, 1);
    assert.equal(report.sessions, 1);
    assert.equal(report.unverified_persons, 1, 'only the never-verified signup older than seven days is purged');
    const persons = await db.admin.query<{ display_name: string }>("SELECT display_name FROM trustwork.person WHERE display_name IN ('never verified', 'recent unverified') ORDER BY 1");
    assert.deepEqual(persons.rows.map((r) => r.display_name), ['recent unverified']);
    const live = await db.admin.query<{ tokens: number; sessions: number; records: number }>('SELECT (SELECT count(*) FROM trustwork.auth_token)::int AS tokens, (SELECT count(*) FROM trustwork.session WHERE revoked_at IS NULL)::int AS sessions, (SELECT count(*) FROM trustwork.idempotency_record)::int AS records');
    assert.deepEqual(live.rows[0], { tokens: 1, sessions: 2, records: 1 });
    const again = await withMaintenance(db.admin, (trx) => maintenance.sweepExpired(trx));
    assert.deepEqual([again.auth_tokens, again.sessions, again.unverified_persons], [0, 0, 0], 'idempotent');
  });
});
