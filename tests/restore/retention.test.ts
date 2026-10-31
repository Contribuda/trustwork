import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { deriveBackupKey } from '../../infra/backup/src/crypto.js';
import { inOwnerTransaction, parseRetentionPolicy, planRetention, runRetention, type RetentionPolicy } from '../../infra/backup/src/retention.js';
import { filesystemTarget, getSealed } from '../../infra/backup/src/target.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';

const env = await provisionWorkerDatabase('restore_retention');

test('OPS-003 partition retention on real PostgreSQL: detach, archive, verify, drop; holds, pending work and the window are respected', { skip: env ? false : SKIP_REASON, timeout: 180_000 }, async (t) => {
  if (!env) return;
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-retention-'));
  const clients: pg.Client[] = [];
  const client = async (connectionString: string | pg.ClientConfig) => {
    const c = new pg.Client(typeof connectionString === 'string' ? { connectionString } : connectionString);
    c.on('error', () => undefined);
    await c.connect();
    clients.push(c);
    return c;
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    rmSync(dir, { recursive: true, force: true });
    await env.close();
  });
  const target = filesystemTarget(dir);
  const key = deriveBackupKey('primary', randomBytes(32));
  const admin = await client(env.db.adminConfig);
  const owner = <T>(fn: () => Promise<T>) => inOwnerTransaction(admin, fn);
  const partition = (table: string, year: number, month: number) => {
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();
    return admin.query(`CREATE TABLE trustwork.${table}_y${year}m${String(month).padStart(2, '0')} PARTITION OF trustwork.${table} FOR VALUES FROM ('${from}') TO ('${to}')`);
  };
  const exists = async (name: string) => (await admin.query<{ r: string | null }>('SELECT to_regclass($1)::text AS r', [`trustwork.${name}`])).rows[0]?.r !== null;

  // Old months (synthetic): Nov 2023 .. Mar 2024 for audit, Jan .. Feb 2024 for outbox, plus a month inside the window.
  const inside = new Date(Date.now() - 200 * 86_400_000);
  const held = await owner(async () => {
    for (const [table, y, m] of [['audit_event', 2023, 11], ['audit_event', 2023, 12], ['audit_event', 2024, 1], ['audit_event', 2024, 2], ['audit_event', 2024, 3], ['outbox_event', 2024, 1], ['outbox_event', 2024, 2]] as const) await partition(table, y, m);
    await partition('audit_event', inside.getUTCFullYear(), inside.getUTCMonth() + 1);
    const person = (await admin.query<{ id: string }>("INSERT INTO trustwork.person (display_name) VALUES ('Retention synthetic person') RETURNING id")).rows[0]!.id;
    const artifact = (await admin.query<{ id: string }>(`INSERT INTO trustwork.evidence_artifact (owner_person_id, parent_kind, parent_id, classification, storage_key, sha256, bytes, media_type, uploaded_by, legal_hold)
      VALUES ($1, 'person', $1, 'owner_private', 'retention/held', $2, 1, 'text/plain', $1, true) RETURNING id`, [person, 'a'.repeat(64)])).rows[0]!.id;
    const audit = (at: string, n = 1, object: [string, string] = ['drill', 'x']) => admin.query(
      `INSERT INTO trustwork.audit_event (occurred_at, action, object_kind, object_id) SELECT $1::timestamptz + make_interval(mins => g), 'synthetic.event', $2, $3 FROM generate_series(1, $4) g`, [at, object[0], object[1], n]);
    await audit('2023-11-10T00:00:00Z', 2);
    await audit('2023-12-10T00:00:00Z', 2);
    await audit('2024-01-10T00:00:00Z', 3);
    await audit('2024-02-10T00:00:00Z', 1);
    await audit('2024-02-11T00:00:00Z', 1, ['evidence_artifact', artifact]);
    await audit('2024-03-15T00:00:00Z', 1);
    await audit(inside.toISOString(), 2);
    await admin.query(`INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload, created_at, published_at) VALUES
      ('drill', 'a', 1, 'synthetic', '{}', '2024-01-05T00:00:00Z', '2024-01-05T00:00:01Z'),
      ('drill', 'b', 1, 'synthetic', '{}', '2024-02-05T00:00:00Z', NULL)`);
    return artifact;
  });
  const policy: RetentionPolicy = parseRetentionPolicy({
    v: 1, hubId: 'us-demo', version: 7, auditEvent: { retainDays: 400 }, outboxEvent: { retainDays: 30 },
    legalHolds: [{ id: 'matter-2024-03', tables: ['audit_event'], from: '2024-03-10T00:00:00Z', to: '2024-03-20T00:00:00Z', reference: 'synthetic matter 2024-03' }],
  });
  const now = new Date();

  await t.test('dry run decides without changing anything', async () => {
    const result = await runRetention({ client: admin, policy, now, apply: false, operator: 'test' });
    const by = Object.fromEntries(result.plan.decisions.map((d) => [d.partition.name, d.action === 'keep' ? d.reason : 'remove']));
    assert.equal(by.audit_event_y2024m01, 'remove');
    assert.equal(by.audit_event_y2024m02, 'held_artifact', `audit rows about artifact ${held} under legal hold keep their month`);
    assert.equal(by.audit_event_y2024m03, 'legal_hold');
    assert.equal(by.outbox_event_y2024m01, 'remove');
    assert.equal(by.outbox_event_y2024m02, 'unpublished');
    assert.equal(by.audit_event_default, 'default_partition');
    assert.equal(by.outbox_event_default, 'default_partition');
    const insideName = `audit_event_y${inside.getUTCFullYear()}m${String(inside.getUTCMonth() + 1).padStart(2, '0')}`;
    assert.ok(['inside_window', 'current_or_future'].includes(by[insideName] as string), `${insideName}: ${by[insideName]}`);
    assert.equal(result.removed.length, 0);
    assert.ok(await exists('audit_event_y2024m01'));
  });

  await t.test('runtime logins cannot run retention (negative authorization)', async () => {
    const worker = await client(env.workerUrl);
    await assert.rejects(runRetention({ client: worker, policy, now, apply: true, target, key, operator: 'worker' }), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(worker.query('ALTER TABLE trustwork.audit_event DETACH PARTITION trustwork.audit_event_y2024m01'), (e: { code?: string }) => e.code === '42501');
    const api = await client(env.db.appConfig);
    await assert.rejects(runRetention({ client: api, policy, now, apply: true, target, key, operator: 'api' }), (e: { code?: string }) => e.code === '42501');
    await assert.rejects(api.query('DROP TABLE trustwork.audit_event_y2024m01'), (e: { code?: string }) => e.code === '42501');
    assert.ok(await exists('audit_event_y2024m01'));
  });

  await t.test('applying needs an archive target; then removes exactly the partitions outside the window, archived and audited', async () => {
    await assert.rejects(runRetention({ client: admin, policy, now, apply: true, operator: 'test' }), /needs a backup target/);
    // Two operators at once: every partition is removed once, archived once, audited once.
    const second = await client(env.db.adminConfig);
    const [a, b] = await Promise.all([
      runRetention({ client: admin, policy, now, apply: true, target, key, operator: 'operator-a' }),
      runRetention({ client: second, policy, now, apply: true, target, key, operator: 'operator-b' }),
    ]);
    const removed = [...a.removed, ...b.removed].sort((x, y) => x.name.localeCompare(y.name));
    assert.deepEqual(removed.map((r) => r.name), ['audit_event_y2023m11', 'audit_event_y2023m12', 'audit_event_y2024m01', 'outbox_event_y2024m01']);
    for (const name of ['audit_event_y2023m11', 'audit_event_y2023m12', 'audit_event_y2024m01', 'outbox_event_y2024m01']) assert.equal(await exists(name), false, name);
    for (const name of ['audit_event_y2024m02', 'audit_event_y2024m03', 'outbox_event_y2024m02']) assert.equal(await exists(name), true, name);
    const jan = removed.find((r) => r.name === 'audit_event_y2024m01')!;
    const archive = (await getSealed(target, key, jan.archiveKey, jan.archiveSha256))!.toString('utf8').trim().split('\n').map((l) => JSON.parse(l) as { action: string; occurred_at: string });
    assert.equal(archive.length, 3);
    assert.ok(archive.every((r) => r.action === 'synthetic.event' && r.occurred_at.startsWith('2024-01-10')));
    assert.equal((await target.store.list('archive/')).length, 4, 'one archive per removed partition');
    const audits = (await owner(() => admin.query<{ object_id: string; basis: { rows: number; operator: string } }>("SELECT object_id, basis FROM trustwork.audit_event WHERE action = 'retention.partition_removed' ORDER BY object_id"))).rows;
    assert.deepEqual(audits.map((r) => [r.object_id, r.basis.rows]), [['audit_event_y2023m11', 2], ['audit_event_y2023m12', 2], ['audit_event_y2024m01', 3], ['outbox_event_y2024m01', 1]]);
    // Kept rows are untouched and audit stays append-only.
    const counts = (await owner(() => admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.audit_event WHERE action = 'synthetic.event'"))).rows[0]!.n;
    assert.equal(counts, 2 + 1 + 2, 'February (2), March (1) and the month inside the window (2) remain');
    await assert.rejects(owner(() => admin.query("DELETE FROM trustwork.audit_event WHERE action = 'synthetic.event'")), /append-only/);
  });

  await t.test('a second run removes nothing more; an outbox month becomes eligible only once its last event is published, a held month never', async () => {
    const again = await runRetention({ client: admin, policy, now, apply: true, target, key, operator: 'test' });
    assert.equal(again.removed.length, 0);
    await owner(() => admin.query("UPDATE trustwork.outbox_event SET published_at = '2024-02-05T00:00:05Z' WHERE aggregate_id = 'b'"));
    const plan = await owner(() => planRetention(admin, policy, now));
    assert.equal(plan.decisions.find((d) => d.partition.name === 'outbox_event_y2024m02')?.action, 'remove');
    assert.equal(plan.decisions.find((d) => d.partition.name === 'audit_event_y2024m03')?.action, 'keep', 'the configured hold still applies');
  });
});
