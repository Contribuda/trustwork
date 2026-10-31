import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_MIGRATIONS_DIR, loadMigrations, migrationStatus, verifyMigrations, migrateUp } from '@trustwork/data/migrate';
import { parseDirectives, splitStatements } from '../../packages/data/src/migrate/sql.js';
import { FOUNDATION_COLUMNS } from '@trustwork/data';
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

/**
 * The twelve migrations applied before the module layout existed (DATA-001, BE-001, RAG-201). Their bare file names
 * are the ledger identity and their SHA-256 checksums are recorded in every existing database: they must never move
 * out of the flat root or change by a single byte.
 */
const APPLIED_FOUNDATION = [
  ['20261027120000_core_functions.sql', '11d290467b110b7f0a0703a3e3aca4ecae2a69b8139ee881d380e201d94da149'],
  ['20261027120100_identity.sql', '31c90b770defc347bd89f56ae8e2c8f68637fd0550d71e89f00ac0bf210fe575'],
  ['20261027120200_company_access.sql', 'd2469d4703a056312ef0bdffd42933266e599fc655fda744449f2f923ab22240'],
  ['20261027120300_projects.sql', '15998ca5a2974abf9809a60684d241aa5b6cf37d19f9fc872b7a200940d14a09'],
  ['20261027120400_reliability.sql', 'b86b4dae3ce8187a93c70d968c72dfb992613df9ed771e313d840e81d693ccaf'],
  ['20261027120500_access_hardening.sql', '9b8f3149d35e2d2995b4e5dc7429e9ef25f5ecf6086e8121ddc54e47e44ddd29'],
  ['20261027120600_membership_hardening.sql', '257878898fc48c00303325c36263f02f18cbebdf94959a17b634ce60b0d63842'],
  ['20261027120700_principal_mac.sql', '954e0ed1e133d15cb8b8a22e9c34839a829c523ce06574e924ebd64a0530cf04'],
  ['20261027120800_admission.sql', '557e9b5982aa5854ea25a36f7476fccbc9d14c3b1433380081dd49ac6e4f67b0'],
  ['20261027120900_identity_commands.sql', '21d49ec8d797c125f54e1824a7cbef52a00e4b7bfec105af77d5ac1063814886'],
  ['20261027121000_public_reads.sql', 'a848629faea42cfd8d95c422c9eb6786a68a43e260c86587a12a923d9ed7b056'],
  ['20261027121100_sweeper_and_review_fixes.sql', '9e0ff534f240f037b3f06e09f6a3a7257d7fdb9f545ff511c7555d773e59933f'],
] as const;

/** Verbatim behaviour of the loader before DATA-004 (flat directory, `.sql` only, sorted, SHA-256 of the UTF-8 text). */
function previousRunnerLoad(directory: string): { filename: string; checksum: string }[] {
  return readdirSync(directory).filter((name) => name.endsWith('.sql')).sort().map((filename) => ({ filename, checksum: createHash('sha256').update(readFileSync(join(directory, filename), 'utf8')).digest('hex') }));
}

/** Writes a migration tree: a copy of the repository tree (same layout) plus `{ 'module/file.sql': sql }` entries. */
function writeTree(directory: string, extra: Record<string, string>, { repository = true } = {}): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  if (repository) {
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) {
      mkdirSync(join(directory, f.module ?? ''), { recursive: true });
      copyFileSync(f.path, join(directory, f.module ?? '', f.filename));
    }
  }
  for (const [relative, sql] of Object.entries(extra)) {
    const target = join(directory, ...relative.split('/'));
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, sql);
  }
}

test('the twelve applied foundation migrations keep their root location, ledger names and checksums', () => {
  const files = loadMigrations(DEFAULT_MIGRATIONS_DIR);
  const byName = new Map(files.map((f) => [f.filename, f]));
  for (const [filename, checksum] of APPLIED_FOUNDATION) {
    const file = byName.get(filename);
    assert.ok(file, `${filename} is still loaded`);
    assert.equal(file.module, null, `${filename} stays in the flat root`);
    assert.equal(file.path, join(DEFAULT_MIGRATIONS_DIR, filename));
    assert.equal(file.checksum, checksum, `${filename} is byte-identical to the applied version`);
  }
  const root = files.filter((f) => f.module === null).map(({ filename, checksum }) => ({ filename, checksum }));
  assert.deepEqual(root, previousRunnerLoad(DEFAULT_MIGRATIONS_DIR), 'the root loads exactly as the previous runner loaded it');
});

test('module layout: root plus one level of module directories, ordered globally by timestamp', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-layout-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeTree(dir, {
    '20300101000300_root_late.sql': 'SELECT 3;\n',
    'plans/20300101000200_plan.sql': 'SELECT 2;\n',
    'plans/20300101000400_plan_more.sql': 'SELECT 4;\n',
    'knowledge/20300101000100_article.sql': '-- trustwork:expect-rows 0\nSELECT 1;\n',
    'knowledge/.gitkeep': '',
    'empty_module/.gitkeep': '',
  }, { repository: false });
  const files = loadMigrations(dir);
  assert.deepEqual(files.map((f) => [f.module, f.filename]), [
    ['knowledge', '20300101000100_article.sql'],
    ['plans', '20300101000200_plan.sql'],
    [null, '20300101000300_root_late.sql'],
    ['plans', '20300101000400_plan_more.sql'],
  ]);
  assert.equal(files[0]?.path, join(dir, 'knowledge', '20300101000100_article.sql'));
  assert.deepEqual(files[0]?.directives, { noTransaction: false, expectRows: { kind: 'exact', value: 0 } });
  assert.equal(files[1]?.checksum, createHash('sha256').update('SELECT 2;\n').digest('hex'), 'checksum covers the file content only, not its directory');
});

test('module layout: nested directories, non-SQL files, malformed names and duplicate names fail loudly', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'trustwork-layout-bad-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases: [string, Record<string, string>, RegExp][] = [
    ['two levels deep', { 'plans/v2/20300101000000_deep.sql': 'SELECT 1;\n' }, /Nested migration directory .*: plans\/v2/],
    ['non-SQL file in a module', { 'plans/notes.md': '# notes\n' }, /Non-SQL file in the migrations directory: plans\/notes\.md/],
    ['non-SQL file in the root', { 'README.txt': 'x\n' }, /Non-SQL file in the migrations directory: README\.txt/],
    ['malformed file name in a module', { 'plans/2030_plan.sql': 'SELECT 1;\n' }, /not <timestamp>_<name>\.sql: plans\/2030_plan\.sql/],
    ['malformed file name in the root', { '20300101000000_Upper.sql': 'SELECT 1;\n' }, /not <timestamp>_<name>\.sql: 20300101000000_Upper\.sql/],
    ['malformed module name', { 'Plans/20300101000000_plan.sql': 'SELECT 1;\n' }, /module directory name .*: Plans/],
    ['same name in two modules', { 'plans/20300101000000_shared.sql': 'SELECT 1;\n', 'knowledge/20300101000000_shared.sql': 'SELECT 2;\n' }, /Duplicate migration file name 20300101000000_shared\.sql in module knowledge and module plans/],
    ['module file shadowing a root file', { 'plans/20261027120000_core_functions.sql': 'SELECT 1;\n' }, /Duplicate migration file name 20261027120000_core_functions\.sql in the root and module plans/],
  ];
  for (const [label, extra, expected] of cases) {
    writeTree(dir, extra, { repository: label.includes('root file') });
    assert.throws(() => loadMigrations(dir), expected, label);
  }
});

test('every live table has exactly one mirror among the schema module files (discovered by listing the directory)', async () => {
  const schemaDir = fileURLToPath(new URL('../../packages/data/src/schema/', import.meta.url));
  const modules = readdirSync(schemaDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && name !== 'index.ts').sort();
  assert.ok(modules.includes('foundation.ts'));
  const owners = new Map<string, string>();
  for (const name of modules) {
    const exported = (await import(pathToFileURL(join(schemaDir, name)).href)) as { TABLE_COLUMNS?: Record<string, readonly string[]> };
    assert.ok(exported.TABLE_COLUMNS, `${name} exports TABLE_COLUMNS`);
    for (const table of Object.keys(exported.TABLE_COLUMNS)) {
      assert.equal(owners.get(table), undefined, `table ${table} is mirrored by both ${owners.get(table)} and ${name}`);
      owners.set(table, name);
    }
  }
  assert.deepEqual(Object.keys(FOUNDATION_COLUMNS).every((table) => owners.get(table) === 'foundation.ts'), true);
});

const db = await provisionTestDatabase('migrations');

test('migration runner against real PostgreSQL', { skip: db ? false : SKIP_REASON }, async (t) => {
  if (!db) return;
  t.after(() => db.close());
  const scratch = mkdtempSync(join(tmpdir(), 'trustwork-migrations-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  await t.test('applies the package migrations from an empty database, then again as a no-op', async () => {
    const applied = await db.migrate();
    assert.deepEqual(applied, loadMigrations(DEFAULT_MIGRATIONS_DIR).map((f) => f.filename));
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

  await t.test('the hand-written Kysely model matches the live schema (tables and columns of every schema module file)', async () => {
    const schemaDir = fileURLToPath(new URL('../../packages/data/src/schema/', import.meta.url));
    const mirror: Record<string, readonly string[]> = {};
    for (const name of readdirSync(schemaDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && n !== 'index.ts')) {
      const { TABLE_COLUMNS } = (await import(pathToFileURL(join(schemaDir, name)).href)) as { TABLE_COLUMNS: Record<string, readonly string[]> };
      Object.assign(mirror, TABLE_COLUMNS);
    }
    const { rows } = await db.admin.query<{ table_name: string; column_name: string }>(
      // Partitions (REL-001: monthly audit_event/outbox_event partitions) are storage of a mirrored parent, not tables of the model.
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'trustwork'
         AND table_name NOT IN (SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'trustwork' AND c.relispartition)
       ORDER BY table_name, ordinal_position`,
    );
    const live = new Map<string, string[]>();
    for (const row of rows) live.set(row.table_name, [...(live.get(row.table_name) ?? []), row.column_name]);
    assert.deepEqual([...live.keys()].sort(), Object.keys(mirror).sort());
    for (const [table, columns] of Object.entries(mirror)) assert.deepEqual([...(live.get(table) ?? [])].sort(), [...columns].sort(), `columns of ${table}`);
  });

  await t.test('upgrading the runner keeps the ledger of an existing database; a module migration is applied by npm run db:migrate', async () => {
    type Row = { filename: string; checksum: string; applied_at: Date; applied_by: string; duration_ms: number; transactional: boolean };
    const ledger = async () => (await db.admin.query<Row>('SELECT filename, checksum, applied_at, applied_by, duration_ms, transactional FROM trustwork.migration_ledger ORDER BY filename')).rows;
    const before = await ledger();
    // The existing database holds exactly what the previous (flat) runner recorded for the foundation files.
    const previous = new Map(previousRunnerLoad(DEFAULT_MIGRATIONS_DIR).map((f) => [f.filename, f.checksum]));
    const foundationRows = before.filter((r) => previous.has(r.filename));
    assert.deepEqual(foundationRows.map((r) => [r.filename, r.checksum]), [...previous]);
    assert.deepEqual(foundationRows.slice(0, APPLIED_FOUNDATION.length).map((r) => [r.filename, r.checksum]), APPLIED_FOUNDATION.map(([f, c]) => [f, c]));

    const dir = join(scratch, 'modules');
    writeTree(dir, {
      'plans_probe/20991231000400_module_probe.sql': 'CREATE TABLE trustwork.module_probe (id uuid PRIMARY KEY DEFAULT trustwork.new_uuid());\nREVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA trustwork FROM PUBLIC;\n',
      'plans_probe/.gitkeep': '',
    });
    const client = await db.admin.connect();
    try {
      const status = await migrationStatus(client, dir);
      assert.deepEqual([status.mismatched, status.missing, status.outOfOrder], [[], [], []], 'no checksum mismatch, nothing missing, nothing out of order');
      assert.deepEqual(status.pending.map((f) => [f.module, f.filename]), [['plans_probe', '20991231000400_module_probe.sql']], 'nothing is re-applied');
    } finally {
      client.release();
    }
    const env = { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string };
    const npm = process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath]] as const : ['npm', []] as const;
    const run = spawnSync(npm[0], [...npm[1], 'run', '--silent', 'db:migrate', '--', '--dir', dir], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /applying 20991231000400_module_probe\.sql[\s\S]*applied 1 migration\(s\)/);
    const after = await ledger();
    assert.deepEqual(after.slice(0, before.length), before, 'existing ledger rows are untouched (same names, checksums, timestamps)');
    assert.deepEqual(after.slice(before.length).map((r) => r.filename), ['20991231000400_module_probe.sql']);
    const probe = await db.admin.query("SELECT to_regclass('trustwork.module_probe') IS NOT NULL AS present");
    assert.equal(probe.rows[0]?.present, true);
    const verify = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'verify', '--dir', dir], { encoding: 'utf8', env });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, new RegExp(`verified ${before.length + 1} applied migration\\(s\\); 0 pending`));
    const again = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'up', '--dir', dir], { encoding: 'utf8', env });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to apply/);
    await db.admin.query('DROP TABLE trustwork.module_probe');
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename = '20991231000400_module_probe.sql'");
  });

  await t.test('a migration two levels deep or a name shared by two modules makes the runner fail without applying anything', async () => {
    const env = { ...process.env, DATABASE_URL: db.adminConfig.connectionString as string };
    const count = async () => (await db.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM trustwork.migration_ledger')).rows[0]?.n;
    const before = await count();
    const deep = join(scratch, 'deep');
    writeTree(deep, { 'plans/20991231000500_ok.sql': 'SELECT 1;\n', 'plans/v2/20991231000600_deep.sql': 'SELECT 1;\n' });
    const nested = spawnSync(process.execPath, ['packages/data/bin/migrate.mjs', 'up', '--dir', deep], { encoding: 'utf8', env });
    assert.equal(nested.status, 1);
    assert.match(nested.stderr, /Nested migration directory .*plans\/v2/);
    const duplicate = join(scratch, 'duplicate');
    writeTree(duplicate, { 'plans/20991231000700_same.sql': 'SELECT 1;\n', 'knowledge/20991231000700_same.sql': 'SELECT 1;\n' });
    const client = await db.admin.connect();
    try {
      await assert.rejects(migrateUp(client, duplicate), /Duplicate migration file name 20991231000700_same\.sql in module knowledge and module plans/);
      await assert.rejects(migrationStatus(client, deep), /Nested migration directory/);
    } finally {
      client.release();
    }
    assert.equal(await count(), before, 'nothing was recorded');
  });

  await t.test('forward-only ordering spans module directories: a module file older than an applied one is refused', async () => {
    const dir = join(scratch, 'module-order');
    writeTree(dir, { 'plans/20991231000800_applied.sql': 'SELECT 1;\n' });
    assert.deepEqual(await db.migrate(dir), ['20991231000800_applied.sql']);
    writeTree(dir, { 'plans/20991231000800_applied.sql': 'SELECT 1;\n', 'knowledge/20991231000750_late_merge.sql': 'SELECT 1;\n' });
    const client = await db.admin.connect();
    try {
      const status = await migrationStatus(client, dir);
      assert.deepEqual(status.outOfOrder, ['20991231000750_late_merge.sql']);
      await assert.rejects(migrateUp(client, dir), /20991231000750_late_merge\.sql sorts before an already applied migration/);
      writeTree(dir, { 'knowledge/20991231000800_applied.sql': 'SELECT 1;\n' });
      const moved = await migrationStatus(client, dir);
      assert.deepEqual([moved.mismatched, moved.missing, moved.pending], [[], [], []], 'the ledger identity is the file name, so moving an unchanged file between modules is not a re-application');
    } finally {
      client.release();
    }
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename LIKE '2099%'");
  });

  await t.test('applying from the previous schema: a later migration only adds its own objects', async () => {
    const dir = join(scratch, 'upgrade');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    for (const f of loadMigrations(DEFAULT_MIGRATIONS_DIR)) copyFileSync(f.path, join(dir, f.filename));
    writeFileSync(join(dir, '20991231000000_follow_up.sql'), "CREATE TABLE trustwork.follow_up (id uuid PRIMARY KEY DEFAULT trustwork.new_uuid());\n");
    assert.deepEqual(await db.migrate(dir), ['20991231000000_follow_up.sql']);
    await db.admin.query('DROP TABLE trustwork.follow_up');
    await db.admin.query("DELETE FROM trustwork.migration_ledger WHERE filename = '20991231000000_follow_up.sql'");
  });

  await t.test('a tampered applied migration is detected by status and verify, and up refuses', async () => {
    const dir = join(scratch, 'tamper');
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
