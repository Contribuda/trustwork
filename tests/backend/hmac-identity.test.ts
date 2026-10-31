import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, sqlState } from '../data/helpers/postgres.js';
import { principalFor, seedFixtures } from '../data/helpers/seed.js';

const db = await provisionTestDatabase('hmac');

/** Median of repeated timings in milliseconds. */
async function median(runs: number, fn: () => Promise<unknown>): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

test('HMAC-verified transaction identity (migration 20261027120700)', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  await db.migrate();
  await db.createAppLogin();
  const seed = await seedFixtures(db.admin);
  const petr = await principalFor(db.admin, seed.people.petr);

  await t.test('the secret is owner-only and the runtime role cannot compute or read it', async () => {
    await assert.rejects(db.app.query('SELECT secret FROM trustwork.principal_key'), (e: unknown) => sqlState(e) === '42501');
    const owner = await withMaintenance(db.admin, (trx) => trx.selectFrom('principal_key').select('id').execute());
    assert.equal(owner.length, 1);
  });

  await t.test('forged set_config of person/company/epoch without the MAC yields no identity and no rows', async () => {
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.person_id', $1, true), set_config('trustwork.company_id', '', true), set_config('trustwork.authz_epoch', $2, true)", [petr.personId, String(petr.authzEpoch)]);
      const identity: pg.QueryResult<{ person: string | null; company: string | null; epoch: number | null }> = await client.query('SELECT trustwork.current_person_id() AS person, trustwork.current_company_id() AS company, trustwork.current_authz_epoch() AS epoch');
      assert.deepEqual(identity.rows[0], { person: null, company: null, epoch: null });
      for (const table of ['person', 'email_binding', 'session', 'object_participation', 'project', 'membership']) {
        const rows: pg.QueryResult<{ n: number }> = await client.query(`SELECT count(*)::int AS n FROM trustwork.${table}`);
        assert.equal(rows.rows[0]?.n, 0, `${table} closed to a forged identity`);
      }
      await client.query("SELECT set_config('trustwork.principal_mac', repeat('0', 64), true)");
      const guessed: pg.QueryResult<{ n: number }> = await client.query('SELECT count(*)::int AS n FROM trustwork.project');
      assert.equal(guessed.rows[0]?.n, 0, 'a guessed MAC is rejected');
      await assert.rejects(client.query('SELECT trustwork.verify_person_id(), trustwork.can_manage_resource($1, $2)', ['project', seed.project]).then((r) => { if (r.rows[0]?.can_manage_resource) throw new Error('definer helper trusted the forged identity'); throw Object.assign(new Error('ok'), { ok: true }); }), (e: unknown) => (e as { ok?: boolean }).ok === true);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await t.test('a MAC captured in one transaction is not valid in another transaction or backend', async () => {
    const client = await db.app.connect();
    let captured: { person: string; company: string; epoch: string; mac: string };
    try {
      await client.query('BEGIN');
      await client.query('SELECT trustwork.set_principal($1::uuid, $2::integer)', [petr.personId, petr.authzEpoch]);
      const r: pg.QueryResult<{ person: string; company: string; epoch: string; mac: string }> = await client.query("SELECT current_setting('trustwork.person_id') AS person, current_setting('trustwork.company_id') AS company, current_setting('trustwork.authz_epoch') AS epoch, current_setting('trustwork.principal_mac') AS mac");
      captured = r.rows[0] as typeof captured;
      assert.equal(((await client.query('SELECT count(*)::int AS n FROM trustwork.project')) as pg.QueryResult<{ n: number }>).rows[0]?.n, 1);
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.person_id', $1, true), set_config('trustwork.company_id', $2, true), set_config('trustwork.authz_epoch', $3, true), set_config('trustwork.principal_mac', $4, true)", [captured.person, captured.company, captured.epoch, captured.mac]);
      const replayed: pg.QueryResult<{ n: number }> = await client.query('SELECT count(*)::int AS n FROM trustwork.project');
      assert.equal(replayed.rows[0]?.n, 0, 'same backend, next transaction: MAC bound to the transaction start time');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const other = await db.app.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT set_config('trustwork.person_id', $1, true), set_config('trustwork.company_id', $2, true), set_config('trustwork.authz_epoch', $3, true), set_config('trustwork.principal_mac', $4, true)", [captured!.person, captured!.company, captured!.epoch, captured!.mac]);
      const replayed: pg.QueryResult<{ n: number }> = await other.query('SELECT count(*)::int AS n FROM trustwork.project');
      assert.equal(replayed.rows[0]?.n, 0, 'other backend: MAC bound to the pid');
      await other.query('ROLLBACK');
    } finally {
      other.release();
    }
  });

  await t.test('the trusted setter still works and malformed text aborts (RL-08 preserved)', async () => {
    const n = await withPrincipal(db.app, petr, async (trx) => (await trx.selectFrom('project').selectAll().execute()).length);
    assert.equal(n, 1);
    const client = await db.app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('trustwork.person_id', 'not-a-uuid', true)");
      await assert.rejects(client.query('SELECT count(*) FROM trustwork.object_participation'), (e: unknown) => sqlState(e) === '22P02');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  await t.test('cost measurement: verifier per call, once-per-query wrapper and a policy-filtered scan', async () => {
    await withMaintenance(db.admin, async (trx) => {
      for (let i = 0; i < 2000; i++) {
        await trx.insertInto('object_participation').values({ resource_kind: 'thread', resource_id: '00000000-0000-7000-8000-' + String(i).padStart(12, '0'), party_person_id: seed.people.carl, side: 'participant', capabilities: ['read.shared'], audience: 'shared_party', granted_by_person_id: seed.people.carl }).execute();
      }
    });
    const carl = await principalFor(db.admin, seed.people.carl);
    const client = await db.app.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT trustwork.set_principal($1::uuid, $2::integer)', [carl.personId, carl.authzEpoch]);
      const perCall = await median(5, () => client.query('SELECT count(*) FROM generate_series(1, 10000) g WHERE trustwork.verify_person_id() IS NOT NULL'));
      const wrapper = await median(5, () => client.query('SELECT count(*) FROM generate_series(1, 10000) g WHERE trustwork.current_person_id() IS NOT NULL'));
      const plain = await median(5, () => client.query("SELECT count(*) FROM generate_series(1, 10000) g WHERE current_setting('trustwork.person_id', true) IS NOT NULL"));
      const scan = await median(5, () => client.query('SELECT count(*) FROM trustwork.object_participation'));
      const rows: pg.QueryResult<{ n: number }> = await client.query('SELECT count(*)::int AS n FROM trustwork.object_participation');
      await client.query('ROLLBACK');
      client.release();
      released = true;
      const report = { verifierPerCallMicros: Number(((perCall * 1000) / 10000).toFixed(2)), wrapper10000CallsMs: Number(wrapper.toFixed(2)), plainGuc10000CallsMs: Number(plain.toFixed(2)), policyScanRows: rows.rows[0]?.n, policyScanMs: Number(scan.toFixed(2)), backend: db.backend };
      console.log(`[hmac-cost] ${JSON.stringify(report)}`);
      assert.ok(rows.rows[0]!.n >= 2000);
      // Timing is reported, not asserted: parallel test files share the database server and absolute numbers vary.
      assert.ok(Number.isFinite(wrapper) && Number.isFinite(perCall) && Number.isFinite(scan));
    } finally {
      if (!released) client.release();
      await db.app.end();
    }
  });
});
