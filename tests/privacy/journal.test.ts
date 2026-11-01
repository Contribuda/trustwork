import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { PrivacyErasureLedger, privacyLedgerFromEnv, provisionLocalPrivacyJournal, type LocalJournalBinding } from '../../apps/api/src/modules/platform-admin/privacy/ledger.js';
import { authorizeLocalPrivacyRestore, reconcileRestore } from '../../scripts/restore/reconcile.js';
import { RoleFence } from '../../scripts/restore/fence.js';
import { runRestoreCli } from '../../scripts/restore/cli.js';
import { provisionWorkerDatabase } from '../worker/helpers/worker-db.js';

const decision = () => ({ version: 1 as const, requestId: randomUUID(), subject: { kind: 'person' as const, id: randomUUID() },
  executedBy: randomUUID(), approvedBy: randomUUID(), policyDigest: '1'.repeat(64), recordedAt: new Date().toISOString(), modules: ['privacy'], suppressionDigests: ['2'.repeat(64)] });
async function fixture(root: string) {
  const id = randomUUID();
  const binding = { authorityDirectory: join(root, `authority-${id}`), journalDirectory: join(root, `journal-${id}`), journalId: id };
  return { binding, ledger: await provisionLocalPrivacyJournal(binding) };
}
function child(command: object) {
  const process = fork(new URL('./fixtures/journal-process.ts', import.meta.url), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  process.stderr!.on('data', (data) => { stderr += String(data); });
  const messages: Array<{ stage?: string; error?: string; done?: boolean }> = [];
  process.on('message', (message) => messages.push(message as typeof messages[number]));
  const exited = once(process, 'exit');
  process.send(command);
  return {
    process, messages, exited,
    async message(predicate: (m: typeof messages[number]) => boolean) {
      const timeout = Date.now() + 20_000;
      while (!messages.some(predicate)) {
        if (process.exitCode !== null || process.signalCode !== null || Date.now() > timeout) throw new Error(`child ended or timed out: ${JSON.stringify(messages)} ${stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return messages.find(predicate)!;
    },
    async finish() { const [code, signal] = await exited; assert.equal(signal, null); return code; },
    async kill() { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await exited; },
  };
}

test('PRV-001 independently retained journal: missing/wrong/rolled-back/corrupt paths and permanent seal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'privacy-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await t.test('environment cannot bootstrap authority or fall back to tmpdir', () => {
    for (const env of [{}, { FILES_STORAGE: 'filesystem' }, { NODE_ENV: 'production' }]) assert.throws(() => privacyLedgerFromEnv(env), /rollout unavailable/);
  });
  await t.test('provisioning is exclusive, with separate directories and an independently pinned identity', async () => {
    const { binding, ledger } = await fixture(root);
    assert.deepEqual(await ledger.all(), []);
    await assert.rejects(provisionLocalPrivacyJournal(binding), /EEXIST/);
    await assert.rejects(new PrivacyErasureLedger({ ...binding, journalId: randomUUID() }).all(), /identity/);
  });
  for (const damage of ['missing', 'empty', 'fresh_same_identity', 'wrong_identity', 'rollback', 'corrupt', 'missing_authority'] as const) {
    await t.test(`${damage} cannot become an empty authoritative journal`, async () => {
      const { binding, ledger } = await fixture(root);
      await ledger.record(decision());
      let selected: LocalJournalBinding = binding;
      if (damage === 'missing_authority') await rm(join(binding.authorityDirectory, 'checkpoint.json'));
      else if (damage === 'rollback') await rm(join(binding.journalDirectory, '000000000001.json'));
      else if (damage === 'corrupt') await writeFile(join(binding.journalDirectory, '000000000001.json'), '{}');
      else {
        const fresh = join(root, `incorrect-${randomUUID()}`);
        selected = { ...binding, journalDirectory: fresh };
        if (damage !== 'missing') await mkdir(fresh);
        if (damage === 'fresh_same_identity') await copyFile(join(binding.journalDirectory, 'identity.json'), join(fresh, 'identity.json'));
        if (damage === 'wrong_identity') await writeFile(join(fresh, 'identity.json'), JSON.stringify({ journalId: randomUUID() }));
      }
      await assert.rejects(new PrivacyErasureLedger(selected).all());
      // Never recreate the authority after a failed check; failure itself leaves a persistent lock.
      await assert.rejects(ledger.all(), /locked/);
    });
  }
  await t.test('identical decisions are idempotent; a contradictory decision is refused', async () => {
    const { ledger } = await fixture(root); const record = decision();
    await ledger.record(record); await ledger.record(record);
    assert.equal((await ledger.all()).length, 1);
    await assert.rejects(ledger.record({ ...record, policyDigest: '3'.repeat(64) }), /conflicting/);
  });
  await t.test('restoration seals the checkpoint irreversibly against later unfenced appends', async () => {
    const { ledger, binding } = await fixture(root);
    await ledger.record(decision());
    await ledger.withRestore(async (entries) => assert.equal(entries.length, 1));
    const reopened = new PrivacyErasureLedger(binding);
    await assert.rejects(reopened.record(decision()), /sealed/);
  });
  for (const pause of ['entry_synced', 'checkpoint_synced'] as const) {
    await t.test(`writer death at ${pause} never permits replay or a replacement writer`, async () => {
      const { binding, ledger } = await fixture(root);
      const writer = child({ binding, action: 'record', record: decision(), pause });
      t.after(() => writer.kill());
      await writer.message((m) => m.stage === pause);
      await writer.kill();
      await assert.rejects(ledger.withRestore(async () => assert.fail('cannot replay after uncertain writer death')), /locked/);
      await assert.rejects(new PrivacyErasureLedger(binding).record(decision()), /locked/);
      const checkpoint = JSON.parse(await readFile(join(binding.authorityDirectory, 'checkpoint.json'), 'utf8'));
      assert.equal(checkpoint.sequence, pause === 'entry_synced' ? 0 : 1);
      assert.equal((await readdir(binding.journalDirectory)).length, 2, 'synced decision remains available for forensic recovery');
    });
  }
});

test('PRV-001 local restore protocol on real PostgreSQL across processes', { timeout: 180_000 }, async (t) => {
  const available = await provisionWorkerDatabase('privacy_journal');
  assert.ok(available, 'embedded PostgreSQL is required for this proof');
  const env = available;
  const root = await mkdtemp(join(tmpdir(), 'privacy-restore-protocol-'));
  const admin = env.db.admin as unknown as pg.Pool;
  const databaseUrl = new URL(env.db.clusterUrl); databaseUrl.pathname = `/${env.db.databaseName}`;
  const fence = new RoleFence(admin, [env.workerLoginRole]);
  t.after(async () => { await fence.lift(); await env.close(); await rm(root, { recursive: true, force: true }); });
  async function setup() {
    const local = await fixture(root); const record = decision(); const restoreId = randomUUID();
    await admin.query("INSERT INTO trustwork.person(id,display_name) VALUES($1,'Synthetic retained-journal subject')", [record.subject.id]);
    await admin.query("INSERT INTO trustwork.privacy_request(id,requested_by,subject_kind,subject_id,kind,country,policy_status,correction) VALUES($1,$2,'person',$2,'correction','ZZ','UNKNOWN',$3)", [record.requestId, record.subject.id, { private: 'Synthetic pre-erasure value' }]);
    await fence.apply();
    const now = new Date();
    await reconcileRestore({ admin, restoreId, recoveryPoint: now, restoreStartedAt: now, journal: { receipts: [], completeThrough: now }, operator: 'synthetic' });
    const authorization = { admin, fence, retainedAuthority: { directory: local.binding.authorityDirectory, journalId: local.binding.journalId }, privacyLedger: local.ledger, restoreId, reference: 'synthetic', operator: 'synthetic' };
    const command = { binding: local.binding, action: 'restore', databaseUrl: databaseUrl.toString(), login: env.workerLoginRole, restoreId };
    return { ...local, record, restoreId, authorization, command };
  }
  async function cannotServe() {
    assert.ok(await fence.isApplied());
    const runtime = new pg.Client({ connectionString: env.workerUrl });
    try { await assert.rejects(runtime.connect(), (error: { code?: string }) => error.code === '28000'); }
    finally { await runtime.end(); }
  }
  async function redacted(requestId: string) {
    assert.deepEqual((await admin.query('SELECT correction FROM trustwork.privacy_request WHERE id=$1', [requestId])).rows[0].correction, { redacted: true });
  }
  await t.test('legacy production CLI remains usable for installations where subject erasure was never enabled', async () => {
    const s = await setup(); const output: string[] = [];
    const code = await runRestoreCli(['authorize', '--restore-id', s.restoreId, '--reference', 'synthetic', '--operator', 'synthetic', '--logins', env.workerLoginRole],
      { NODE_ENV: 'production', RESTORE_DATABASE_URL: databaseUrl.toString() }, { out: (line) => output.push(line), err: (line) => output.push(line) });
    assert.equal(code, 0, output.join('\n')); assert.equal(await fence.isApplied(), false);
    assert.equal((await admin.query('SELECT correction FROM trustwork.privacy_request WHERE id=$1', [s.record.requestId])).rows[0].correction.private, 'Synthetic pre-erasure value');
  });
  await t.test('old DB with no receipts cannot lift the fence using a fresh incorrect journal path', async () => {
    const s = await setup(); await s.ledger.record(s.record);
    const fresh = join(root, 'fresh-incorrect'); await mkdir(fresh);
    assert.equal((await admin.query('SELECT 1 FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [s.record.requestId])).rowCount, 0);
    await assert.rejects(authorizeLocalPrivacyRestore({ ...s.authorization, privacyLedger: new PrivacyErasureLedger({ ...s.binding, journalDirectory: fresh }) }));
    await cannotServe();
    assert.equal((await admin.query("SELECT 1 FROM trustwork.audit_event WHERE action='restore.authorized' AND object_id=$1", [s.restoreId])).rowCount, 0);
  });
  await t.test('a fully provisioned fresh journal cannot replace the installation retained authority', async () => {
    const s = await setup(); await s.ledger.record(s.record);
    const fresh = await fixture(root);
    await assert.rejects(authorizeLocalPrivacyRestore({ ...s.authorization, privacyLedger: fresh.ledger }), /independently pinned/);
    await cannotServe();
    await authorizeLocalPrivacyRestore(s.authorization);
    await redacted(s.record.requestId);
  });
  await t.test('a retained legal hold blocks replay and preserves the old private payload behind the fence', async () => {
    const s = await setup(); await s.ledger.record(s.record);
    await admin.query("INSERT INTO trustwork.legal_hold(request_id,subject_kind,subject_id,reason_code,evidence_ref,placed_by) VALUES($1,'person',$2,'litigation',$3,$2)", [s.record.requestId, s.record.subject.id, randomUUID()]);
    await assert.rejects(authorizeLocalPrivacyRestore(s.authorization), /retained legal hold/);
    await cannotServe();
    assert.equal((await admin.query('SELECT 1 FROM trustwork.privacy_replay_receipt WHERE request_id=$1', [s.record.requestId])).rowCount, 0);
  });
  await t.test('runtime principal cannot replay or authorize a restore', async () => {
    const s = await setup(); await s.ledger.record(s.record);
    await assert.rejects(authorizeLocalPrivacyRestore({ ...s.authorization, admin: env.apiPool as unknown as pg.Pool }), (error: { code?: string }) => error.code === '42501');
    await cannotServe();
  });
  await t.test('writer first: restore refuses while the append is uncommitted; includes it after checkpoint commit', async () => {
    const s = await setup();
    const writer = child({ binding: s.binding, action: 'record', record: s.record, pause: 'entry_synced' }); t.after(() => writer.kill());
    await writer.message((m) => m.stage === 'entry_synced');
    const earlyRestore = child(s.command); t.after(() => earlyRestore.kill());
    assert.match((await earlyRestore.message((m) => !!m.error)).error!, /locked/); assert.equal(await earlyRestore.finish(), 1);
    await cannotServe();
    writer.process.send({ continue: true }); assert.equal(await writer.finish(), 0);
    const restore = child(s.command); t.after(() => restore.kill()); assert.equal(await restore.finish(), 0);
    await redacted(s.record.requestId); assert.equal(await fence.isApplied(), false);
    const checkpoint = (await admin.query("SELECT basis->'privacyCheckpoint' AS checkpoint FROM trustwork.audit_event WHERE action='restore.authorized' AND object_id=$1", [s.restoreId])).rows[0].checkpoint;
    assert.equal(checkpoint.journalId, s.binding.journalId); assert.equal(checkpoint.sequence, 1); assert.equal(checkpoint.sealed, true);
  });
  await t.test('restore first: append after snapshot and before lift is refused; no append after the sealed handover', async () => {
    const s = await setup(); await s.ledger.record(s.record);
    const restore = child({ ...s.command, pause: 'restore_sealed' }); t.after(() => restore.kill());
    await restore.message((m) => m.stage === 'restore_sealed');
    const writer = child({ binding: s.binding, action: 'record', record: decision() }); t.after(() => writer.kill());
    assert.match((await writer.message((m) => !!m.error)).error!, /locked/); assert.equal(await writer.finish(), 1);
    await cannotServe(); restore.process.send({ continue: true }); assert.equal(await restore.finish(), 0);
    await redacted(s.record.requestId);
    const late = child({ binding: s.binding, action: 'record', record: decision() }); t.after(() => late.kill());
    assert.match((await late.message((m) => !!m.error)).error!, /sealed/); assert.equal(await late.finish(), 1);
  });
  for (const pause of ['restore_sealed', 'before_lift'] as const) {
    await t.test(`restore process death at ${pause} keeps runtime denied, including retry by a new process`, async () => {
      const s = await setup(); await s.ledger.record(s.record);
      const restore = child({ ...s.command, pause }); t.after(() => restore.kill());
      await restore.message((m) => m.stage === pause);
      const audit = await admin.query("SELECT 1 FROM trustwork.audit_event WHERE action='restore.authorized' AND object_id=$1", [s.restoreId]);
      assert.equal(audit.rowCount, pause === 'before_lift' ? 1 : 0, 'distinguishes pre-replay from committed DB/pre-lift crash');
      if (pause === 'before_lift') await redacted(s.record.requestId);
      await cannotServe(); await restore.kill();
      const retry = child(s.command); t.after(() => retry.kill());
      assert.match((await retry.message((m) => !!m.error)).error!, /locked/); assert.equal(await retry.finish(), 1);
      await cannotServe();
    });
  }
});
