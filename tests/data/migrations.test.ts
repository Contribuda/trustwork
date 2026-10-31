import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, migrationStatus, verifyMigrations, migrateUp } from '@trustwork/data/migrate';
import { parseDirectives, splitStatements } from '../../packages/data/src/migrate/sql.js';
import { SCHEMA_COLUMNS } from '@trustwork/data';
import { provisionTestDatabase, SKIP_REASON, sqlState } from './helpers/postgres.js';

test('statement splitter keeps dollar-quoted bodies, strings and comments intact', () => {
  const script = `-- leading comment; with semicolon\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; RAISE NOTICE 'a;b'; END $$;\nINSERT INTO t VALUES ('x;y', "q;r") /* c; */;\nCREATE INDEX CONCURRENTLY i ON t (a)\n`;
  const parts = splitStatements(script);
  assert.equal(parts.length, 3);
  assert.match(parts[0] as string, /PERFORM 1; RAISE NOTICE 'a;b'; END \$\$$/);
  assert.match(parts[1] as string, /^INSERT/);
  assert.match(parts[2] as string, /^CREATE INDEX CONCURRENTLY/);
});

test('directives are parsed from the leading comment block only', () => {
  assert.deepEqual(parseDirectives('-- trustwork:no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);'), { noTransaction: true, expectRows: null });
  assert.deepEqual(parseDirectives('-- data fix\n-- trustwork:expect-rows min:2\nUPDATE t SET a = 1;'), { noTransaction: false, expectRows: { kind: 'min', value: 2 } });
  assert.deepEqual(parseDirectives('UPDATE t SET a = 1; -- trustwork:expect-rows 1'), { noTransaction: false, expectRows: null });
  assert.throws(() => parseDirectives('-- trustwork:expect-rows many\n'), /Invalid/);
  assert.throws(() => parseDirectives('-- trustwork:no-transaction\n-- trustwork:expect-rows 1\n'), /cannot be combined/);
  assert.throws(() => parseDirectives('-- trustwork:rewrite-history\n'), /Unknown migration directive/);
});

test('repository migrations have canonical names, no transaction-free files and unique checksums', () => {
  const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
  assert.ok(files.length >= 5);
  assert.deepEqual(files.map((f) => f.filename), [...files.map((f) => f.filename)].sort());
  assert.equal(new Set(files.map((f) => f.checksum)).size, files.length);
  for (const f of files) assert.equal(f.directives.noTransaction, false, `${f.filename} must be transactional`);
});

const db = await provisionTestDatabase('migrations');

test('migration runner against real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  const scratch = mkdtempSync(join(tmpdir(), 'trustwork-migrations-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  await t.test('applies the package migrations from an empty database, then again as a no-op', async () => {
    const applied = await db.migrate();
    assert.deepEqual(applied, readdirSync(DEFAULT_MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort());
    assert.deepEqual(await db.migrate(), []);
    const client = await db.admin.connect();
    try {
      const status = await migrationStatus(client);
      assert.equal(status.applied.length, applied.length);
      assert.deepEqual(status.pending, []);
      assert.deepEqual(status.mismatched, []);
      const ledger = await client.query<{ filename: string; checksum: string; applied_by: string; transactional: boolean }>('SELECT * FROM trustwork.migration_ledger ORDER BY filename');
      assert.equal(ledger.rows.length, applied.length);
      assert.ok(ledger.rows.every((r) => /^[a-f0-9]{64}$/.test(r.checksum) && r.transactional));
      const owner = await client.query<{ tableowner: string }>("SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'trustwork'");
      assert.deepEqual(owner.rows.map((r) => r.tableowner), ['trustwork_owner']);
    } finally {
      client.release();
    }
  });

  await t.test('the hand-written Kysely model matches the live schema (tables and columns)', async () => {
    const { rows } = await db.admin.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'trustwork' ORDER BY table_name, ordinal_position",
    );
    const live = new Map<string, string[]>();
    for (const row of rows) live.set(row.table_name, [...(live.get(row.table_name) ?? []), row.column_name]);
    assert.deepEqual([...live.keys()].sort(), Object.keys(SCHEMA_COLUMNS).sort());
    for (const [table, columns] of Object.entries(SCHEMA_COLUMNS)) assert.deepEqual([...(live.get(table) ?? [])].sort(), [...columns].sort(), `columns of ${table}`);
  });

  await t.test('applying from the previous schema: a later migration only adds its own objects', async () => {
    const dir = join(scratch, 'upgrade');
    rmSync(dir, { recursive: true, force: true });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20991231000000_follow_up.sql'), "CREATE TABLE trustwork.follow_up (id uuid PRIMARY KEY DEFAULT trustwork.new_uuid());\n");
    assert.deepEqual(await db.migrate(dir), ['20991231000000_follow_up.sql']);
    await db.admin.query('DROP TABLE trustwork.follow_up');
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename = '20991231000000_follow_up.sql'");
  });

  await t.test('a tampered applied migration is detected by status and verify, and up refuses', async () => {
    const dir = join(scratch, 'tamper');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    for (const f of files) copyFileSync(f.path, join(dir, f.filename));
    const victim = files[0] as (typeof files)[number];
    writeFileSync(join(dir, victim.filename), victim.script + '\n-- edited after apply\n');
    const client = await db.admin.connect();
    try {
      const status = await migrationStatus(client, dir);
      assert.equal(status.mismatched.length, 1);
      assert.equal(status.mismatched[0]?.filename, victim.filename);
      await assert.rejects(verifyMigrations(client, dir), /Checksum mismatch .*immutable/);
      await assert.rejects(migrateUp(client, dir), /Checksum mismatch/);
      const cli = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'verify', '--dir', dir], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string } });
      assert.equal(cli.status, 1);
      assert.match(cli.stderr, /Checksum mismatch/);
      const ok = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'status'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string } });
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /applied {2}20261027120000_core_functions\.sql/);
      const usage = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'up'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
      assert.equal(usage.status, 2);
      assert.match(usage.stderr, /No database configured/);
    } finally {
      client.release();
    }
  });

  await t.test('a missing applied file and an out-of-order pending file are refused', async () => {
    const dir = join(scratch, 'order');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
    for (const f of files.slice(1)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20200101000000_too_early.sql'), 'SELECT 1;\n');
    const client = await db.admin.connect();
    try {
      const status = await migrationStatus(client, dir);
      assert.deepEqual(status.missing, [files[0]?.filename]);
      assert.deepEqual(status.outOfOrder, ['20200101000000_too_early.sql']);
      await assert.rejects(migrateUp(client, dir), /missing from the migrations directory[\s\S]*forward-only ordering/);
    } finally {
      client.release();
    }
  });

  await t.test('expect-rows aborts and rolls back a data migration that touched the wrong number of rows', async () => {
    const dir = join(scratch, 'rows');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20991231000100_seed_three.sql'), "-- trustwork:expect-rows 3\nINSERT INTO trustwork.company (display_name) VALUES ('Rows A'), ('Rows B');\n");
    await assert.rejects(db.migrate(dir), /affected 2 rows, expected exact 3; rolled back/);
    const after = await db.admin.query("SELECT count(*)::int AS n FROM trustwork.migration_ledger WHERE filename LIKE '2099%'");
    assert.equal(after.rows[0]?.n, 0);
    const client = await db.admin.connect();
    try {
      await client.query("SET LOCAL ROLE trustwork_owner; SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_owner');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      const companies = await client.query("SELECT count(*)::int AS n FROM trustwork.company WHERE display_name LIKE 'Rows %'");
      assert.equal(companies.rows[0]?.n, 0, 'rolled back inserts are not visible');
      await client.query('ROLLBACK');
    } finally {
      client.release(true);
    }
    writeFileSync(join(dir, '20991231000100_seed_three.sql'), "-- trustwork:expect-rows min:2\nINSERT INTO trustwork.company (display_name) VALUES ('Rows A'), ('Rows B');\n");
    assert.deepEqual(await db.migrate(dir), ['20991231000100_seed_three.sql']);
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename LIKE '2099%'");
  });

  await t.test('a data migration run as the owner without the maintenance flag sees zero rows (FORCE RLS on the owner)', async () => {
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_owner');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      await client.query("INSERT INTO trustwork.person (display_name) VALUES ('Maintenance Probe')");
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE trustwork_owner');
      const hidden = await client.query('SELECT count(*)::int AS n FROM trustwork.person');
      assert.equal(hidden.rows[0]?.n, 0, 'owner without maintenance flag is filtered by FORCE RLS');
      const silentUpdate = await client.query("UPDATE trustwork.person SET display_name = 'x' WHERE display_name = 'Maintenance Probe'");
      assert.equal(silentUpdate.rowCount, 0, 'this is why expect-rows exists');
      await client.query("SELECT set_config('trustwork.maintenance', 'on', true)");
      const visible = await client.query('SELECT count(*)::int AS n FROM trustwork.person');
      assert.equal(visible.rows[0]?.n, 1);
      await client.query('COMMIT');
      const afterCommit = await client.query("SELECT current_setting('trustwork.maintenance', true) AS m");
      assert.equal(afterCommit.rows[0]?.m ?? '', '');
    } finally {
      client.release(true);
    }
  });

  await t.test('a no-transaction migration runs statement by statement (CREATE INDEX CONCURRENTLY)', async () => {
    const dir = join(scratch, 'concurrent');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20991231000200_concurrent_index.sql'), '-- trustwork:no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS company_display_name_idx ON trustwork.company (display_name);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS company_claim_idx ON trustwork.company (claim_status);\n');
    assert.deepEqual(await db.migrate(dir), ['20991231000200_concurrent_index.sql']);
    const ledger = await db.admin.query<{ transactional: boolean }>("SELECT transactional FROM trustwork.migration_ledger WHERE filename = '20991231000200_concurrent_index.sql'");
    assert.equal(ledger.rows[0]?.transactional, false);
    const indexes = await db.admin.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'trustwork' AND indexname IN ('company_display_name_idx', 'company_claim_idx')");
    assert.equal(indexes.rows.length, 2);
    const role = await db.admin.query<{ r: string }>('SELECT current_user AS r');
    assert.notEqual(role.rows[0]?.r, 'trustwork_owner', 'session role is reset after a non-transactional migration');
    await db.admin.query('DROP INDEX trustwork.company_display_name_idx, trustwork.company_claim_idx');
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename LIKE '2099%'");
  });

  await t.test('a failing migration leaves the ledger untouched and the transaction rolled back', async () => {
    const dir = join(scratch, 'failing');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20991231000300_broken.sql'), "CREATE TABLE trustwork.half (id int);\nINSERT INTO trustwork.half VALUES ('not an int');\n");
    const error = await db.migrate(dir).catch((e: unknown) => e);
    assert.equal(sqlState(error), '22P02', String(error));
    const half = await db.admin.query("SELECT to_regclass('trustwork.half') IS NOT NULL AS present");
    assert.equal(half.rows[0]?.present, false);
    const ledger = await db.admin.query("SELECT count(*)::int AS n FROM trustwork.migration_ledger WHERE filename = '20991231000300_broken.sql'");
    assert.equal(ledger.rows[0]?.n, 0);
  });
});
