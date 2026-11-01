import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupRecordSchema } from '@trustwork/contracts';
import { applyPrune, backupObjects, listManifests, planPrune, shipWal, type BackupManifest } from '../../infra/backup/src/backup.js';
import { backupKeyFromEnv, BackupCryptoError, deriveBackupKey, envelopeKeyId, Keyring, keyringFromEnv, open, seal } from '../../infra/backup/src/crypto.js';
import { PgExec, pgExecFromEnv, type PgExecError } from '../../infra/backup/src/pg.js';
import { decidePartition, parseRetentionPolicy, type PartitionInfo, type RetentionPolicy } from '../../infra/backup/src/retention.js';
import { backupTargetFromEnv, filesystemTarget, getSealed, putSealed } from '../../infra/backup/src/target.js';
import { runBackupCli } from '../../infra/backup/cli.js';
import { FilesystemBlobStore } from '../../packages/data/src/files/filesystem.js';
import { FENCE_BEGIN, hbaFenceBlock, withoutHbaFence, RoleFence } from '../../scripts/restore/fence.js';
import { jobMode, KNOWN_JOB_MODES, parseReceipts } from '../../scripts/restore/reconcile.js';
import { tarHeader } from '../../scripts/restore/stage.js';
import { parseDrillArgs, DEFAULT_DRILL } from '../../scripts/restore/drill.js';
import { runRestoreCli } from '../../scripts/restore/cli.js';
import { buildRegistry } from '../../apps/worker/src/main.js';
import { createMailTransport, mailConfigFromEnv } from '../../apps/worker/src/mail/index.js';
import { Metrics, silentLogger } from '../../apps/worker/src/index.js';
import { TombstoneLedger } from '../../packages/data/src/files/tombstones.js';
import { FakeMalwareScanner } from '../../apps/worker/src/files/scanner.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'trustwork-restore-unit-'));

test('OPS-003 envelope: AES-256-GCM over gzip, bound to the object key, tamper-evident, rotatable', () => {
  const key = deriveBackupKey('primary', randomBytes(32));
  const plaintext = Buffer.from('synthetic row {"id":1} '.repeat(200), 'utf8');
  const sealed = seal(key, plaintext, 'base/x/part-00000');
  assert.equal(envelopeKeyId(sealed), 'primary');
  assert.ok(!sealed.includes(Buffer.from('synthetic row')), 'no plaintext in the envelope');
  assert.ok(sealed.length < plaintext.length, 'compressed before encryption');
  assert.deepEqual(open(key, sealed, 'base/x/part-00000'), plaintext);
  assert.throws(() => open(key, sealed, 'base/x/part-00001'), BackupCryptoError, 'a part cannot be swapped under another name');
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 20] = (tampered[tampered.length - 20] as number) ^ 1;
  assert.throws(() => open(key, tampered, 'base/x/part-00000'), /failed authentication/);
  assert.throws(() => open(deriveBackupKey('primary', randomBytes(32)), sealed, 'base/x/part-00000'), /failed authentication/, 'wrong key');
  // Rotation: a new current key still reads envelopes of the old one through the keyring.
  const next = deriveBackupKey('next', randomBytes(32));
  const ring = new Keyring(next).add(key);
  assert.deepEqual(open(ring, sealed, 'base/x/part-00000'), plaintext);
  assert.throws(() => open(new Keyring(next), sealed, 'base/x/part-00000'), /no backup key with id primary/);
});

test('OPS-003 backup key configuration: from the environment only, at least 32 bytes, never a default', () => {
  assert.throws(() => backupKeyFromEnv({}), /BACKUP_ENCRYPTION_KEY is required/);
  assert.throws(() => backupKeyFromEnv({ BACKUP_ENCRYPTION_KEY: 'abcd' }), /at least 32 bytes/);
  assert.throws(() => backupKeyFromEnv({ BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), BACKUP_KEY_ID: 'bad id' }), /key id/);
  const hex = randomBytes(32).toString('hex');
  assert.equal(backupKeyFromEnv({ BACKUP_ENCRYPTION_KEY: hex }).id, 'primary');
  assert.deepEqual(backupKeyFromEnv({ BACKUP_ENCRYPTION_KEY: Buffer.from(hex, 'hex').toString('base64'), BACKUP_KEY_ID: 'k1' }).dataKey, deriveBackupKey('k1', Buffer.from(hex, 'hex')).dataKey, 'hex and base64 decode to the same secret');
  const old = randomBytes(32).toString('hex');
  const ring = keyringFromEnv({ BACKUP_ENCRYPTION_KEY: hex, BACKUP_KEY_ID: '2026-11', BACKUP_ENCRYPTION_KEY_2026_10: old });
  assert.ok(ring.get('2026-11') && ring.get('2026_10'));
});

test('OPS-003 targets: filesystem fake refused in production, s3 needs operator configuration, size verified on put', async () => {
  assert.throws(() => backupTargetFromEnv({}), /BACKUP_TARGET must be filesystem or s3/);
  assert.throws(() => backupTargetFromEnv({ BACKUP_TARGET: 'filesystem', BACKUP_FS_ROOT: '/tmp/x', NODE_ENV: 'production' }), /refused with NODE_ENV=production/);
  assert.throws(() => backupTargetFromEnv({ BACKUP_TARGET: 's3', BACKUP_S3_BUCKET: 'b' }), /BACKUP_S3_ENDPOINT, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY/);
  const s3 = backupTargetFromEnv({ BACKUP_TARGET: 's3', BACKUP_S3_ENDPOINT: 'https://s3.example.invalid', BACKUP_S3_BUCKET: 'trustwork-backups', BACKUP_S3_ACCESS_KEY_ID: 'id', BACKUP_S3_SECRET_ACCESS_KEY: 'secret' });
  assert.deepEqual([s3.kind, s3.offHost], ['s3', true]);
  const dir = tmp();
  try {
    const target = filesystemTarget(dir);
    assert.equal(target.offHost, false, 'the local fake is recorded honestly as not off-host');
    const key = deriveBackupKey('primary', randomBytes(32));
    const put = await putSealed(target, key, 'wal/000000010000000000000001', Buffer.from('wal bytes'));
    assert.equal(put.bytes, 9);
    assert.deepEqual(await getSealed(target, key, 'wal/000000010000000000000001', put.sha256), Buffer.from('wal bytes'));
    await assert.rejects(getSealed(target, key, 'wal/000000010000000000000001', 'f'.repeat(64)), /digest mismatch/);
    assert.equal(await getSealed(target, key, 'wal/000000010000000000000002'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A PgExec stand-in for the spool (shipWal only uses these three calls). */
function fakeSpool(files: Record<string, Buffer>) {
  return {
    options: { prefix: [], user: 'u', database: 'd', walSpool: '/spool' },
    spooled: async () => Object.keys(files).sort(),
    readSpooled: async (name: string) => files[name] as Buffer,
    removeSpooled: async (name: string) => { delete files[name]; },
  } as unknown as PgExec;
}

test('OPS-003 WAL shipping: sealed upload then spool removal; identical re-archive accepted; conflicting content refused and kept', async () => {
  const dir = tmp();
  try {
    const target = filesystemTarget(dir);
    const key = deriveBackupKey('primary', randomBytes(32));
    const spool: Record<string, Buffer> = { '000000010000000000000001': randomBytes(1024), '00000002.history': Buffer.from('1\t0/3000000\tno recovery target specified\n') };
    const first = await shipWal({ exec: fakeSpool(spool), target, key });
    assert.deepEqual([first.shipped.length, Object.keys(spool).length], [2, 0]);
    const segment = (await getSealed(target, key, 'wal/000000010000000000000001')) as Buffer;
    const again = { '000000010000000000000001': Buffer.from(segment) };
    assert.deepEqual((await shipWal({ exec: fakeSpool(again), target, key })).alreadyPresent, ['000000010000000000000001']);
    const conflict = { '000000010000000000000001': randomBytes(1024) };
    await assert.rejects(shipWal({ exec: fakeSpool(conflict), target, key }), /different content; refusing to overwrite/);
    assert.equal(Object.keys(conflict).length, 1, 'a conflicting file stays in the spool for the operator');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const manifest = (format: BackupManifest['format'], id: string, finishedAt: string, startWal?: string, parts = 1): BackupManifest => ({
  v: 1, id, format, nodeId: 'n', startedAt: finishedAt, finishedAt, keyId: 'primary', target: { kind: 'filesystem', offHost: false },
  parts: Array.from({ length: parts }, (_, i) => ({ key: `${format === 'physical' ? 'base' : format}/${id}/part-${i}`, bytes: 1, sha256: '0'.repeat(64), sealedBytes: 1, sealedSha256: '0'.repeat(64) })),
  totalBytes: parts, ...(startWal ? { pg: { serverVersion: '180003', timeline: 1, startWal, startLsn: '0/0', endLsn: '0/0', endWal: startWal } } : {}),
});

test('OPS-003 backup retention: nothing inside the window is removed; the newest restore point always survives', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const physical = [
    manifest('physical', 'base-old', '2026-09-01T00:00:00Z', '000000010000000000000002', 2),
    manifest('physical', 'base-mid', '2026-10-20T00:00:00Z', '000000010000000000000010'),
    manifest('physical', 'base-new', '2026-10-30T00:00:00Z', '000000010000000000000020'),
  ];
  const wal = ['000000010000000000000002', '000000010000000000000009', '000000010000000000000010', '000000010000000000000021', '00000002.history'];
  const plan = planPrune({ now, keepDays: 14, physical, logical: [manifest('logical', 'logical-old', '2026-01-01T00:00:00Z')], objects: [], wal });
  assert.deepEqual(plan.remove.map((r) => r.key).sort(), ['base/base-old/manifest.json', 'base/base-old/part-0', 'base/base-old/part-1', 'wal/000000010000000000000002', 'wal/000000010000000000000009'].sort());
  assert.ok(plan.keep.includes('logical/logical-old/manifest.json'), 'the newest logical dump is kept even outside the window');
  assert.ok(plan.keep.includes('wal/00000002.history'));
  // Everything outside the window but the newest backup: still restorable.
  const all = planPrune({ now, keepDays: 1, physical, logical: [], objects: [], wal });
  assert.ok(all.keep.includes('base/base-new/manifest.json') && all.keep.includes('wal/000000010000000000000021'));
  assert.ok(!all.remove.some((r) => r.key === 'wal/000000010000000000000021'));
  assert.throws(() => planPrune({ now, keepDays: 0, physical, logical: [], objects: [], wal }), /positive integer/);
});

test('OPS-003 object backup is content-addressed; prune drops blobs no kept manifest references', async () => {
  const dir = tmp();
  try {
    const target = filesystemTarget(join(dir, 'target'));
    const key = deriveBackupKey('primary', randomBytes(32));
    const source = new FilesystemBlobStore({ root: join(dir, 'files') });
    await source.put('a/1', Buffer.from('one'));
    await source.put('a/2', Buffer.from('one'));
    await source.put('tombstones/x.json', Buffer.from('{}'));
    const first = await backupObjects({ target, key, nodeId: 'n', source, excludePrefixes: ['tombstones/'] });
    assert.equal(BackupRecordSchema.parse(first.record).kind, 'object_store');
    assert.deepEqual(first.manifest.objects?.map((o) => o.storageKey), ['a/1', 'a/2']);
    assert.equal((await target.store.list('objects/blob/')).length, 1, 'identical bytes are stored once');
    const listed = await listManifests(target, key, 'objects');
    assert.equal(listed.length, 1);
    const removed = await applyPrune(target, { keep: [], remove: [{ key: `objects/${first.manifest.id}/manifest.json`, reason: 'test' }] }, []);
    assert.equal(removed, 2);
    assert.deepEqual(await target.store.list('objects/'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const policy = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => parseRetentionPolicy({ v: 1, hubId: 'us-demo', version: 3, auditEvent: { retainDays: 400 }, outboxEvent: { retainDays: 30 }, legalHolds: [], ...overrides });
const part = (table: PartitionInfo['table'], from: string | null, to: string | null): PartitionInfo => ({ table, name: `${table}_x`, from: from ? new Date(from) : null, to: to ? new Date(to) : null });

test('OPS-003 partition retention decisions: the window, engine floors, legal holds, pending work, default and current months', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const none = { rows: 5, unpublished: 0, heldArtifactRefs: 0 };
  assert.throws(() => policy({ auditEvent: { retainDays: 364 } }), /auditEvent.retainDays/, 'below the audit floor is refused, never clamped');
  assert.throws(() => policy({ outboxEvent: { retainDays: 29 } }), /outboxEvent.retainDays/);
  assert.throws(() => parseRetentionPolicy({ v: 1, hubId: 'h', version: 1, auditEvent: { retainDays: 400 }, outboxEvent: { retainDays: 30 }, legalHolds: [{ id: 'h1', tables: ['audit_event'], from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z', reference: 'x' }] }), /ends after it starts/);
  assert.equal(decidePartition(part('audit_event', null, null), none, policy(), now).action, 'keep');
  assert.equal(decidePartition(part('audit_event', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z'), none, policy(), now).action, 'keep');
  // Window: 400 days before now is 2025-09-26; September 2025 ends after the cutoff -> kept; August 2025 -> removed.
  const sept = decidePartition(part('audit_event', '2025-09-01T00:00:00Z', '2025-10-01T00:00:00Z'), none, policy(), now);
  assert.deepEqual([sept.action, sept.action === 'keep' && sept.reason], ['keep', 'inside_window']);
  assert.equal(decidePartition(part('audit_event', '2025-08-01T00:00:00Z', '2025-09-01T00:00:00Z'), none, policy(), now).action, 'remove');
  // Boundary: a partition ending exactly at the cutoff holds only rows older than the window.
  const exact = new Date(Date.UTC(2026, 9, 1));
  const atCutoff = decidePartition(part('outbox_event', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), none, policy(), new Date(exact.getTime() + 30 * 86_400_000));
  assert.equal(atCutoff.action, 'remove');
  const justInside = decidePartition(part('outbox_event', '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z'), none, policy(), new Date(exact.getTime() + 30 * 86_400_000 - 1));
  assert.equal(justInside.action, 'keep');
  const held = policy({ legalHolds: [{ id: 'matter-7', tables: ['audit_event'], from: '2025-08-15T00:00:00Z', to: null, reference: 'case 7' }] });
  const kept = decidePartition(part('audit_event', '2025-08-01T00:00:00Z', '2025-09-01T00:00:00Z'), none, held, now);
  assert.deepEqual([kept.action, kept.action === 'keep' && kept.reason], ['keep', 'legal_hold']);
  assert.equal(decidePartition(part('outbox_event', '2025-08-01T00:00:00Z', '2025-09-01T00:00:00Z'), none, held, now).action, 'remove', 'a hold applies to the tables it names');
  const artifact = decidePartition(part('audit_event', '2025-08-01T00:00:00Z', '2025-09-01T00:00:00Z'), { ...none, heldArtifactRefs: 1 }, policy(), now);
  assert.equal(artifact.action === 'keep' && artifact.reason, 'held_artifact');
  const pending = decidePartition(part('outbox_event', '2025-08-01T00:00:00Z', '2025-09-01T00:00:00Z'), { ...none, unpublished: 2 }, policy(), now);
  assert.equal(pending.action === 'keep' && pending.reason, 'unpublished');
});

test('OPS-003 restore fence block: first-match reject rules for both runtime groups, removable without touching other rules', () => {
  const block = hbaFenceBlock();
  assert.match(block, /^# trustwork-restore-fence begin/);
  for (const group of ['trustwork_worker', 'trustwork_app']) for (const type of ['local all', 'host all', 'hostssl all', 'hostnossl all']) assert.ok(block.includes(`${type} +${group}`), `${type} +${group}`);
  const original = 'local all all trust\nhost all all all scram-sha-256\n';
  assert.equal(withoutHbaFence(block + original), original);
  assert.equal(withoutHbaFence(original), original);
  assert.throws(() => withoutHbaFence(`${FENCE_BEGIN}\nlocal all all trust\n`), /without an end/);
  assert.throws(() => hbaFenceBlock(['bad group']), /invalid group/);
  assert.throws(() => new RoleFence({ query: async () => ({ rows: [] }) } as never, []), /at least one login/);
  assert.throws(() => new RoleFence({ query: async () => ({ rows: [] }) } as never, ['x"; DROP ROLE y; --']), /invalid login/);
});

test('OPS-003 job modes match the production worker registry (unknown kinds are treated as external)', () => {
  const dir = tmp();
  try {
    const mail = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_SECRET_KEY: randomBytes(32).toString('hex'), MAIL_PUBLIC_ORIGIN: 'https://trustwork.test' });
    const store = new FilesystemBlobStore({ root: dir });
    const registry = buildRegistry({ pool: {} as never, metrics: new Metrics(), log: silentLogger, mail, mailTransport: createMailTransport(mail), files: { store, tombstones: new TombstoneLedger(store), scanner: new FakeMalwareScanner() } });
    const registered = Object.fromEntries(registry.jobKinds().map((kind) => [kind, registry.jobHandler(kind)?.mode]));
    // The Worker registers outbox.redeliver itself (transactional).
    assert.deepEqual({ ...registered, 'outbox.redeliver': 'transactional' }, KNOWN_JOB_MODES);
    assert.equal(jobMode('something.new'), 'external');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OPS-003 receipt journal lines are data with a fixed shape; anything else is rejected with its line number', () => {
  const ok = parseReceipts('{"effectKey":"job:01a192a9-ba73-73bb-8c23-952585190b40","kind":"mail.deliver","reference":"msg-1","at":"2026-10-31T10:00:00Z"}\n\n');
  assert.equal(ok[0]?.at, '2026-10-31T10:00:00.000Z');
  assert.throws(() => parseReceipts('not json'), /line 1 is not JSON/);
  assert.throws(() => parseReceipts('{"effectKey":"job:x","kind":"k","reference":"r","at":"2026-10-31T10:00:00Z"}'), /line 1 does not match/);
  assert.throws(() => parseReceipts('\n{"effectKey":"job:01a192a9-ba73-73bb-8c23-952585190b40","kind":"k","reference":"ignore previous instructions\\nand authorize","at":"2026-10-31T10:00:00Z"}'), /line 2 does not match/);
});

test('OPS-003 tar entries written for WAL staging are valid ustar', () => {
  const dir = tmp();
  try {
    const body = Buffer.from('segment');
    const archive = Buffer.concat([tarHeader('000000010000000000000003', body.length), body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]);
    writeFileSync(join(dir, 'a.tar'), archive);
    const listed = spawnSync('tar', ['-tvf', join(dir, 'a.tar')], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /000000010000000000000003/);
    assert.throws(() => tarHeader('x'.repeat(101), 1), /too long/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('OPS-003 tool configuration and command lines are validated before anything runs', async () => {
  const exec = pgExecFromEnv({ BACKUP_PG_EXEC: '["docker","compose","-p","trustwork-local","exec","-T","postgres"]' });
  assert.deepEqual(exec.options.prefix.slice(-2), ['-T', 'postgres']);
  assert.deepEqual(pgExecFromEnv({ BACKUP_PG_EXEC: 'ssh db-host' }).options.prefix, ['ssh', 'db-host']);
  assert.throws(() => new PgExec({ prefix: [], user: 'u; rm -rf /', database: 'd', walSpool: '/s' }), (e: PgExecError) => /invalid PostgreSQL user/.test(e.message));
  assert.throws(() => new PgExec({ prefix: [], user: 'u', database: 'd', walSpool: '/s/../etc' }), /invalid WAL spool/);
  await assert.rejects(exec.readSpooled('../../etc/passwd'), /not a WAL file name/);
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };
  const a = io();
  assert.equal(await runBackupCli(['nonsense'], {}, a.io), 2);
  const b = io();
  assert.equal(await runBackupCli(['base'], {}, b.io), 1);
  assert.match(b.err.join(), /BACKUP_ENCRYPTION_KEY is required|BACKUP_TARGET must be/);
  const c = io();
  assert.equal(await runBackupCli(['retention', '--policy', '/nonexistent.json'], { BACKUP_TARGET: 'filesystem' }, c.io), 1);
  const d = io();
  assert.equal(await runRestoreCli(['destroy', '--project', 'trustwork-local', '--volume', 'v'], {}, d.io), 2, 'the live stack project is refused');
  const d2 = io();
  assert.equal(await runRestoreCli(['destroy', '--project', 'trustwork-stack', '--volume', 'v'], {}, d2.io), 2, 'the documented full-stack project is refused too');
  const e = io();
  assert.equal(await runRestoreCli(['reconcile'], {}, e.io), 1);
  assert.deepEqual(parseDrillArgs(['--no-pitr', '--evidence', 'x.json']), { ...DEFAULT_DRILL, pitrCheck: false, evidencePath: 'x.json' });
  assert.throws(() => parseDrillArgs(['--bogus']), /unknown argument/);
});
