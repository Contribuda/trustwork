import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { jobs, mailDeliveries, withMaintenance, withPrincipal, preIdentity } from '@trustwork/data';
import { FakeMailTransport, mailConfigFromEnv, registerMail, type MailTransport } from '../../../apps/worker/src/mail/index.js';
import { HandlerRegistry, Metrics, silentLogger, Worker } from '../../../apps/worker/src/index.js';
import { screeningNoticeAllowed } from '../../../packages/data/src/repositories/screening-notices.js';
import { principalFor } from '../../data/helpers/seed.js';
import { SKIP_REASON } from '../../data/helpers/postgres.js';
import { gate, provisionWorkerDatabase, tx, waitFor } from '../../worker/helpers/worker-db.js';
import { drain } from '../../worker/mail/helpers/stack.js';

const env = await provisionWorkerDatabase('sanc007_notice_authority');
test('SANC-007 notice authority at the real transport boundary', { skip: env ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin;
  const pool = env.workerPool(6);
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '100' });
  const makeWorker = (transport: MailTransport) => {
    const registry = new HandlerRegistry();
    registerMail(registry, { pool, config, transport, log: silentLogger, metrics: new Metrics() });
    const worker = new Worker({ pool, registry, config: { concurrency: 1 }, tasks: () => [] });
    t.after(() => worker.stop(200));
    return worker;
  };
  const row = async (id: string) => (await admin.query('SELECT * FROM trustwork.mail_delivery WHERE id = $1', [id])).rows[0]!;
  const fixture = async () => withMaintenance(admin, async (trx) => {
    const address = `notice-${randomUUID()}@example.invalid`;
    const person = await trx.insertInto('person').values({ display_name: 'Synthetic Notice Subject' }).returning('id').executeTakeFirstOrThrow();
    const binding = await trx.insertInto('email_binding').values({ person_id: person.id, email_normalized: address, verified_at: new Date(), is_primary: true }).returning('id').executeTakeFirstOrThrow();
    await sql`SELECT trustwork.screening_record_notice(${person.id}::uuid, 'hold')`.execute(trx);
    const delivery = await trx.selectFrom('mail_delivery').select('id').where('recipient', '=', address).executeTakeFirstOrThrow();
    return { personId: person.id, bindingId: binding.id, id: delivery.id, address };
  });
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  await t.test('no verified binding at enqueue produces no notice or authority; authority cannot be rewritten', async () => {
    await withMaintenance(admin, async (trx) => {
      const subject = await trx.insertInto('person').values({ display_name: 'Synthetic Unbound Subject' }).returning('id').executeTakeFirstOrThrow();
      const before = await trx.selectFrom('mail_delivery').select('id').execute();
      await sql`SELECT trustwork.screening_record_notice(${subject.id}::uuid, 'hold')`.execute(trx);
      assert.equal((await trx.selectFrom('mail_delivery').select('id').execute()).length, before.length);
      assert.equal((await trx.selectFrom('screening_notice_authority').select('delivery_id').where('person_id', '=', subject.id).execute()).length, 0);
    });
    const f = await fixture();
    await assert.rejects(withMaintenance(admin, (trx) => trx.updateTable('screening_notice_authority').set({ binding_id: randomUUID() }).where('delivery_id', '=', f.id).execute()));
    await assert.rejects(withMaintenance(admin, (trx) => trx.deleteFrom('screening_notice_authority').where('delivery_id', '=', f.id).execute()));
    const fake = new FakeMailTransport(); await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 1);
  });
  const reuse = async (f: Fixture, blocked?: ReturnType<typeof gate>, entered?: ReturnType<typeof gate>, pid?: (n: number) => void) => {
    const principal = await principalFor(admin, f.personId);
    return withPrincipal(env.apiPool, principal, async (trx) => {
      pid?.((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid);
      // Actual restricted-role binding write, followed by the identity command that removes the old binding.
      await trx.updateTable('email_binding').set({ verified_at: null }).where('id', '=', f.bindingId).execute();
      const newOwner = await preIdentity.claimUnverifiedBinding(trx, { displayName: 'Synthetic New Mailbox Owner', emailNormalized: f.address, provider: 'google', subject: randomUUID() });
      assert.ok(newOwner && newOwner !== f.personId);
      entered?.open();
      await blocked?.promise;
      return newOwner;
    });
  };
  await t.test('a removed/reassigned verified binding never delivers the former person notice', async () => {
    const f = await fixture();
    const newOwner = await reuse(f);
    const binding = (await admin.query('SELECT id, person_id FROM trustwork.email_binding WHERE email_normalized = $1', [f.address])).rows[0]!;
    assert.equal(binding.person_id, newOwner);
    assert.notEqual(binding.id, f.bindingId);
    const fake = new FakeMailTransport();
    await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 0);
    assert.equal((await row(f.id)).state, 'suppressed');
    assert.equal((await row(f.id)).recipient, null);
  });
  await t.test('missing authority, removed binding and unverified binding fail closed; unauthorized insertion is refused', async () => {
    for (const mode of ['missing', 'removed', 'unverified'] as const) {
      const f = await fixture();
      if (mode === 'missing') {
        // A legacy/forged generic mail intent has no transition-owned authority.
        await withMaintenance(admin, async (trx) => {
          await trx.updateTable('mail_delivery').set({ state: 'suppressed', recipient: null }).where('id', '=', f.id).execute();
          const old = await trx.selectFrom('mail_delivery').selectAll().where('id', '=', f.id).executeTakeFirstOrThrow();
          const id = randomUUID();
          await trx.insertInto('mail_delivery').values({ id, template: 'screening_notice', recipient: f.address, recipient_hash: old.recipient_hash, params: JSON.stringify({ kind: 'hold' }), locale_preferences: ['en'] }).execute();
          await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: id, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
          f.id = id;
        });
      } else if (mode === 'removed') {
        await withMaintenance(admin, (trx) => trx.deleteFrom('email_binding').where('id', '=', f.bindingId).execute());
      } else {
        await withPrincipal(env.apiPool, await principalFor(admin, f.personId), (trx) => trx.updateTable('email_binding').set({ verified_at: null }).where('id', '=', f.bindingId).execute());
      }
      for (const restricted of [env.apiPool, pool]) {
        await assert.rejects(restricted.query('INSERT INTO trustwork.screening_notice_authority (delivery_id, person_id, binding_id) VALUES ($1, $2, $3)', [f.id, f.personId, f.bindingId]), { code: '42501' });
        await assert.rejects(restricted.query('SELECT * FROM trustwork.screening_notice_authority'), { code: '42501' });
      }
      await assert.rejects(env.apiPool.query('SELECT trustwork.screening_notice_allowed($1)', [f.id]), { code: '42501' });
      assert.equal(await tx(pool, (trx) => screeningNoticeAllowed(trx, f.id)), false);
      const fake = new FakeMailTransport();
      await drain(makeWorker(fake));
      assert.equal(fake.sent.length, 0, mode);
      assert.equal((await row(f.id)).state, 'suppressed');
    }
  });
  await t.test('binding removal/reuse wins the lock: dispatch waits and then refuses', async () => {
    const f = await fixture();
    const changed = gate(); const commit = gate();
    t.after(() => commit.open());
    let mutationPid = 0;
    const mutation = reuse(f, commit, changed, (pid) => { mutationPid = pid; });
    await changed.promise;
    const fake = new FakeMailTransport();
    const sending = drain(makeWorker(fake));
    try {
      await waitFor(async () => (await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [mutationPid])).rows.length > 0, 15_000, 'dispatch blocked by binding command');
      assert.equal(fake.sent.length, 0);
    } finally { commit.open(); }
    await mutation; await sending;
    assert.equal(fake.sent.length, 0);
    assert.equal((await row(f.id)).state, 'suppressed');
  });
  await t.test('dispatch wins the lock: binding command waits through the actual provider effect', async () => {
    const f = await fixture(); const entered = gate(); const release = gate();
    t.after(() => release.open());
    const fake = new FakeMailTransport();
    const transport: MailTransport = { name: 'fake', maxDurationMs: 30_000, async send(mail, signal) { entered.open(); await release.promise; return fake.send(mail, signal); } };
    const sending = drain(makeWorker(transport));
    await entered.promise;
    let mutationPid = 0;
    const mutation = reuse(f, undefined, undefined, (pid) => { mutationPid = pid; });
    try {
      await waitFor(async () => mutationPid > 0 && (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND cardinality(pg_blocking_pids(pid)) > 0', [mutationPid])).rows.length > 0, 15_000, 'binding command blocked by provider transaction');
      assert.equal(fake.sent.length, 0);
    } finally { release.open(); }
    await sending; await mutation;
    assert.equal(fake.sent.length, 1);
    assert.equal(fake.sent[0]?.to, f.address);
    assert.equal((await row(f.id)).state, 'sent');
    await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 1);
  });
  await t.test('an admitted unknown send remains parked after reuse, duplicate intents and restart', async () => {
    const f = await fixture();
    const fake = new FakeMailTransport(); fake.failFor(f.address, 'unknown');
    await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 1);
    assert.equal((await row(f.id)).state, 'sending');
    const jobId = (await row(f.id)).job_id as string;
    assert.equal((await admin.query('SELECT state FROM trustwork.job WHERE id = $1', [jobId])).rows[0]?.state, 'outcome_unknown');
    await reuse(f);
    await tx(pool, async (trx) => { await jobs.enqueue(trx, { kind: 'mail.deliver', payload: { deliveryId: f.id } }); });
    await drain(makeWorker(fake));
    assert.equal(fake.sent.length, 1);
    assert.equal((await row(f.id)).state, 'sending', 'revocation does not relabel an already admitted unknown effect as unsent');
  });
  await t.test('a late provider receipt retains the binding lock after timeout and never triggers a second send', async () => {
    const f = await fixture(); const entered = gate(); const release = gate();
    let effects = 0;
    const transport: MailTransport = { name: 'fake', maxDurationMs: 1, async send() {
      entered.open(); await release.promise; effects += 1; return { providerMessageId: 'synthetic-late-receipt' };
    } };
    const running = drain(makeWorker(transport));
    await entered.promise;
    let mutationPid = 0;
    const mutation = reuse(f, undefined, undefined, (pid) => { mutationPid = pid; });
    try {
      await running; // The production runner times out while the deliberately uncooperative fake is still running.
      const jobId = (await row(f.id)).job_id as string;
      assert.equal((await admin.query('SELECT state FROM trustwork.job WHERE id = $1', [jobId])).rows[0]?.state, 'outcome_unknown');
      assert.equal((await admin.query('SELECT cardinality(pg_blocking_pids($1)) AS n', [mutationPid])).rows[0]?.n > 0, true);
      assert.equal(effects, 0);
    } finally { release.open(); }
    await mutation;
    await waitFor(async () => (await row(f.id)).state === 'sent');
    assert.equal((await row(f.id)).provider_message_id, 'synthetic-late-receipt');
    const restarted = new FakeMailTransport(); await drain(makeWorker(restarted));
    assert.equal(effects, 1); assert.equal(restarted.sent.length, 0);
  });
  await t.test('process death after the provider effect parks the admitted send; replay and new holder cause no extra send', async () => {
    const f = await fixture();
    const dir = mkdtempSync(join(tmpdir(), 'sanc007-notice-crash-'));
    const ledger = join(dir, 'ledger'); const ready = join(dir, 'ready');
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./notice-crash-worker.ts', import.meta.url))], {
      env: { ...process.env, WORKER_DATABASE_URL: env.workerUrl, SANC_NOTICE_LEDGER: ledger, SANC_NOTICE_READY: ready }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
    try {
      await waitFor(() => existsSync(ready) || child.exitCode !== null, 30_000, 'child provider effect');
      assert.ok(existsSync(ready), stderr.slice(-800));
      assert.equal(readFileSync(ledger, 'utf8').trim(), `${f.id}@${config.messageIdDomain}`);
      child.kill('SIGKILL'); assert.equal(await exited, 'SIGKILL');
      const jobId = (await row(f.id)).job_id as string;
      await waitFor(async () => (await admin.query('SELECT 1 FROM trustwork.job WHERE id = $1 AND leased_until < now()', [jobId])).rows.length > 0);
      await tx(pool, (trx) => jobs.expireLeases(trx));
      assert.equal((await row(f.id)).state, 'sending');
      assert.equal((await admin.query('SELECT state FROM trustwork.job WHERE id = $1', [jobId])).rows[0]?.state, 'outcome_unknown');
      await reuse(f);
      const fake = new FakeMailTransport();
      await tx(pool, (trx) => jobs.enqueue(trx, { kind: 'mail.deliver', payload: { deliveryId: f.id } }));
      await drain(makeWorker(fake));
      assert.equal(fake.sent.length, 0);
      assert.equal(readFileSync(ledger, 'utf8').trim().split('\n').length, 1);
      await tx(pool, (trx) => jobs.reconcile(trx, jobId, 'succeeded', 'synthetic-ledger:one-confirmed-effect'));
      await tx(pool, (trx) => mailDeliveries.settle(trx));
      await drain(makeWorker(fake));
      assert.equal(fake.sent.length, 0);
      assert.equal((await row(f.id)).recipient, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
