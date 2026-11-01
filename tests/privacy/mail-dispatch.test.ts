import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobs, mailDeliveries, withMaintenance } from '@trustwork/data';
import { FakeMailTransport, mailConfigFromEnv, registerMail, type MailTransport } from '../../apps/worker/src/mail/index.js';
import { HandlerRegistry, Metrics, silentLogger, Worker } from '../../apps/worker/src/index.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { gate, provisionWorkerDatabase, tx, waitFor } from '../worker/helpers/worker-db.js';
import { drain } from '../worker/mail/helpers/stack.js';

test('PRV retained contact barrier in actual MAIL dispatch, receipt and crash reconciliation', { timeout: 120_000 }, async (t) => {
  const env = await provisionWorkerDatabase('privacy_mail_dispatch');
  if (!env) { t.skip(SKIP_REASON); return; }
  t.after(() => env.close());
  const admin = env.db.admin; const pool = env.workerPool(6);
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '100' });
  const makeWorker = (transport: MailTransport) => {
    const registry = new HandlerRegistry(); registerMail(registry, { pool, config, transport, log: silentLogger, metrics: new Metrics() });
    const worker = new Worker({ pool, registry, config: { concurrency: 1 }, tasks: () => [] });
    t.after(() => worker.stop(200)); return worker;
  };
  const row = async (id: string) => (await admin.query('SELECT * FROM trustwork.mail_delivery WHERE id=$1', [id])).rows[0]!;
  const fixture = async (transactional = false) => withMaintenance(admin, async (trx) => {
    const address = `synthetic-privacy-${randomUUID()}@example.invalid`; const id = randomUUID(); const digest = mailAddressHash(address);
    await trx.insertInto('mail_delivery').values({ id, recipient: address, recipient_hash: digest, template: 'notification', locale_preferences: ['en'],
      params: JSON.stringify({ subject: 'Synthetic message', body: 'Synthetic privacy transport test', path: '/app/privacy', transactional: String(transactional) }) }).execute();
    await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: id, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
    return { id, address, digest };
  });
  const object = (digest: string) => env.apiPool.query('SELECT trustwork.privacy_marketing_object($1)', [digest]);
  await t.test('objection first: claim passes the uncommitted objection; final dispatch waits and suppresses', async () => {
    const f = await fixture(); const entered = gate(); const release = gate(); t.after(() => release.open()); let pid = 0;
    const objection = tx(env.apiPool, async (_trx, client) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [f.digest]); entered.open(); await release.promise;
    });
    await entered.promise; const fake = new FakeMailTransport(); const sending = drain(makeWorker(fake));
    try {
      await waitFor(async () => (await row(f.id)).state === 'sending' && (await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0);
      assert.equal(fake.sent.length, 0);
    } finally { release.open(); }
    await objection; await sending; assert.equal(fake.sent.length, 0); assert.equal((await row(f.id)).state, 'suppressed');
  });
  await t.test('dispatch first: objection waits through real transport, receipt and commit', async () => {
    const f = await fixture(); const entered = gate(); const release = gate(); t.after(() => release.open()); const fake = new FakeMailTransport();
    const transport: MailTransport = { name: 'fake', maxDurationMs: 30_000, async send(mail, signal) { entered.open(); await release.promise; return fake.send(mail, signal); } };
    const sending = drain(makeWorker(transport)); await entered.promise; let pid = 0; let acknowledged = false;
    const objection = tx(env.apiPool, async (_trx, client) => {
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [f.digest]);
    }).then(() => { acknowledged = true; });
    try {
      await waitFor(async () => pid > 0 && (await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0].n > 0);
      assert.equal(acknowledged, false); assert.equal(fake.sent.length, 0);
    } finally { release.open(); }
    await sending; await objection; assert.equal(fake.sent.length, 1); assert.equal((await row(f.id)).state, 'sent');
    await drain(makeWorker(fake)); assert.equal(fake.sent.length, 1);
  });
  await t.test('marketing objection does not invent authority to suppress transactional notices', async () => {
    const f = await fixture(true); await object(f.digest); const fake = new FakeMailTransport(); await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 1); assert.equal((await row(f.id)).state, 'sent');
  });
  await t.test('unknown outcome stays parked after objection and duplicate enqueue; reconciliation never resends', async () => {
    const f = await fixture(); const fake = new FakeMailTransport(); fake.failFor(f.address, 'unknown'); await drain(makeWorker(fake));
    const jobId = (await row(f.id)).job_id; assert.equal(fake.sent.length, 1);
    assert.equal((await admin.query('SELECT state FROM trustwork.job WHERE id=$1', [jobId])).rows[0].state, 'outcome_unknown');
    await object(f.digest); await tx(pool, (trx) => jobs.enqueue(trx, { kind: 'mail.deliver', payload: { deliveryId: f.id } }));
    await drain(makeWorker(fake)); assert.equal(fake.sent.length, 1);
    await tx(pool, (trx) => jobs.reconcile(trx, jobId, 'succeeded', 'synthetic-effect-confirmed'));
    await tx(pool, (trx) => mailDeliveries.settle(trx)); await drain(makeWorker(fake)); assert.equal(fake.sent.length, 1);
  });
  await t.test('late receipt keeps the contact lock after runner timeout and prevents a second send', async () => {
    const f = await fixture(); const entered = gate(); const release = gate(); t.after(() => release.open()); let effects = 0;
    const running = drain(makeWorker({ name: 'fake', maxDurationMs: 1, async send() { entered.open(); await release.promise; effects++; return { providerMessageId: 'synthetic-privacy-late' }; } }));
    await entered.promise; let acknowledged = false; const objection = object(f.digest).then(() => { acknowledged = true; });
    try { await running; assert.equal(acknowledged, false); assert.equal(effects, 0); }
    finally { release.open(); }
    await objection; await waitFor(async () => (await row(f.id)).state === 'sent');
    assert.equal((await row(f.id)).provider_message_id, 'synthetic-privacy-late');
    const fake = new FakeMailTransport(); await drain(makeWorker(fake)); assert.equal(fake.sent.length, 0); assert.equal(effects, 1);
  });
  await t.test('actual killed process after effect: retained objection, lease reconciliation and zero extra sends', async () => {
    const f = await fixture(); const dir = mkdtempSync(join(tmpdir(), 'prv-mail-crash-'));
    const ledger = join(dir, 'ledger'); const ready = join(dir, 'ready');
    // Reuse the merged SANC fixture and actual production handler; do not recreate its worker implementation.
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../web/compliance/notice-crash-worker.ts', import.meta.url))], {
      env: { ...process.env, WORKER_DATABASE_URL: env.workerUrl, SANC_NOTICE_LEDGER: ledger, SANC_NOTICE_READY: ready }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
    try {
      await waitFor(() => existsSync(ready) || child.exitCode !== null, 30_000, 'actual child provider effect');
      assert.ok(existsSync(ready), stderr.slice(-800)); assert.equal(readFileSync(ledger, 'utf8').trim(), `${f.id}@${config.messageIdDomain}`);
      child.kill('SIGKILL'); assert.equal(await exited, 'SIGKILL'); await object(f.digest);
      const jobId = (await row(f.id)).job_id;
      await waitFor(async () => (await admin.query('SELECT 1 FROM trustwork.job WHERE id=$1 AND leased_until<now()', [jobId])).rowCount! > 0);
      await tx(pool, (trx) => jobs.expireLeases(trx));
      assert.equal((await admin.query('SELECT state FROM trustwork.job WHERE id=$1', [jobId])).rows[0].state, 'outcome_unknown');
      await tx(pool, (trx) => jobs.enqueue(trx, { kind: 'mail.deliver', payload: { deliveryId: f.id } }));
      const fake = new FakeMailTransport(); await drain(makeWorker(fake)); assert.equal(fake.sent.length, 0);
      await tx(pool, (trx) => jobs.reconcile(trx, jobId, 'succeeded', 'synthetic-ledger-confirmed'));
      await tx(pool, (trx) => mailDeliveries.settle(trx)); await drain(makeWorker(fake)); assert.equal(fake.sent.length, 0);
      assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; rmSync(dir, { recursive: true, force: true });
    }
  });
});
