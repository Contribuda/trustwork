import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance } from '@trustwork/data';
import { FakeMailTransport, mailConfigFromEnv, registerMail, type MailTransport } from '../../apps/worker/src/mail/index.js';
import { HandlerRegistry, Metrics, silentLogger, Worker } from '../../apps/worker/src/index.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { gate, provisionWorkerDatabase, tx, waitFor } from '../worker/helpers/worker-db.js';
import { drain } from '../worker/mail/helpers/stack.js';

/**
 * PRV-001 acceptance: an objection submitted while an outreach batch is queued cancels the queued touches. Today the
 * only outreach the engine sends is marketing mail through MAIL; OUTR-002 will add campaigns on top of the same
 * barrier. Every queued touch to the objecting address ends `suppressed` with zero transport effects, whichever side
 * wins the race; touches to other recipients are unaffected, and a touch already in transport finishes once.
 */
test('PRV objection during a queued marketing batch: queued touches to that address are cancelled, nothing else changes', { timeout: 120_000 }, async (t) => {
  const env = await provisionWorkerDatabase('privacy_outreach_batch');
  if (!env) { t.skip(SKIP_REASON); return; }
  t.after(() => env.close());
  const admin = env.db.admin; const pool = env.workerPool(6);
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '100' });
  const makeWorker = (transport: MailTransport, concurrency = 3) => {
    const registry = new HandlerRegistry(); registerMail(registry, { pool, config, transport, log: silentLogger, metrics: new Metrics() });
    const worker = new Worker({ pool, registry, config: { concurrency }, tasks: () => [] });
    t.after(() => worker.stop(200)); return worker;
  };
  const states = async (ids: string[]) => (await admin.query<{ state: string }>('SELECT state FROM trustwork.mail_delivery WHERE id = ANY($1::uuid[]) ORDER BY id', [ids])).rows.map((r) => r.state);
  /** A queued batch: `touches` marketing touches to the objector plus one touch to each of `others` recipients. */
  const batch = async (touches: number, others: number) => withMaintenance(admin, async (trx) => {
    const objector = `synthetic-objector-${randomUUID()}@example.invalid`;
    const queue = async (address: string) => {
      const id = randomUUID();
      await trx.insertInto('mail_delivery').values({ id, recipient: address, recipient_hash: mailAddressHash(address), template: 'notification', locale_preferences: ['en'],
        params: JSON.stringify({ subject: 'Synthetic outreach', body: 'Synthetic outreach batch touch', path: '/app/privacy', transactional: 'false' }) }).execute();
      await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: id, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
      return id;
    };
    // Other recipients are queued first, so a worker that drains in order reaches them before the objector's touches.
    const theirs: string[] = []; for (let i = 0; i < others; i++) theirs.push(await queue(`synthetic-recipient-${randomUUID()}@example.invalid`));
    const mine: string[] = []; for (let i = 0; i < touches; i++) mine.push(await queue(objector));
    return { objector, digest: mailAddressHash(objector), mine, theirs };
  });
  const object = (digest: string) => env.apiPool.query('SELECT trustwork.privacy_marketing_object($1)', [digest]);

  await t.test('objection lands while the batch is queued and another recipient is in transport: zero touches reach the objector', async () => {
    const f = await batch(4, 5);
    const entered = gate(); const release = gate(); t.after(() => release.open());
    const fake = new FakeMailTransport();
    const transport: MailTransport = { name: 'fake', maxDurationMs: 30_000, async send(mail, signal) {
      if (!mail.to.startsWith('synthetic-objector-')) { entered.open(); await release.promise; }
      return fake.send(mail, signal);
    } };
    const sending = drain(makeWorker(transport, 1));
    await entered.promise;
    // The objection is public and unconditional; it commits while the batch is still queued.
    await object(f.digest);
    release.open(); await sending;
    assert.equal(fake.sent.filter((m) => m.to === f.objector).length, 0, 'no queued touch to the objector left');
    assert.deepEqual(await states(f.mine), Array(4).fill('suppressed'));
    assert.deepEqual(await states(f.theirs), Array(5).fill('sent'));
    assert.equal(fake.sent.length, 5);
    await drain(makeWorker(fake)); assert.equal(fake.sent.length, 5, 'a later worker pass sends nothing more');
  });
  await t.test('objection arrives while one touch to the objector is in transport: that touch finishes once, the rest of the batch is cancelled', async () => {
    const f = await batch(4, 2);
    const entered = gate(); const release = gate(); t.after(() => release.open());
    const fake = new FakeMailTransport(); let inTransport = 0;
    const transport: MailTransport = { name: 'fake', maxDurationMs: 30_000, async send(mail, signal) {
      if (mail.to === f.objector && inTransport++ === 0) { entered.open(); await release.promise; }
      return fake.send(mail, signal);
    } };
    const sending = drain(makeWorker(transport, 1));
    await entered.promise;
    let acknowledged = false; let pid = 0;
    const objection = tx(env.apiPool, async (_trx, client) => {
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid').then((r) => r.rows[0]!)).pid;
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [f.digest]);
    }).then(() => { acknowledged = true; });
    try {
      await waitFor(async () => pid > 0 && (await admin.query<{ n: number }>('SELECT cardinality(pg_blocking_pids($1)) AS n', [pid])).rows[0]!.n > 0, 10_000, 'objection waits for the in-flight touch');
      assert.equal(acknowledged, false, 'the objection does not commit under an in-flight touch to the same address');
    } finally { release.open(); }
    await sending; await objection;
    assert.equal(fake.sent.filter((m) => m.to === f.objector).length, 1, 'the touch already in transport completes exactly once');
    const mine = await states(f.mine);
    assert.equal(mine.filter((s) => s === 'sent').length, 1); assert.equal(mine.filter((s) => s === 'suppressed').length, 3);
    assert.deepEqual(await states(f.theirs), Array(2).fill('sent'));
    await drain(makeWorker(fake)); assert.equal(fake.sent.filter((m) => m.to === f.objector).length, 1);
  });
  await t.test('a batch queued after the objection never sends to the objector; transactional notices are untouched', async () => {
    const f = await batch(3, 1);
    await object(f.digest);
    const notice = randomUUID();
    await withMaintenance(admin, async (trx) => {
      await trx.insertInto('mail_delivery').values({ id: notice, recipient: f.objector, recipient_hash: f.digest, template: 'notification', locale_preferences: ['en'],
        params: JSON.stringify({ subject: 'Synthetic security notice', body: 'Synthetic transactional', path: '/app/security', transactional: 'true' }) }).execute();
      await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: notice, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
    });
    const fake = new FakeMailTransport(); await drain(makeWorker(fake));
    assert.deepEqual(await states(f.mine), Array(3).fill('suppressed'));
    assert.deepEqual(await states([notice]), ['sent']);
    assert.deepEqual(await states(f.theirs), ['sent']);
    assert.equal(fake.sent.filter((m) => m.to === f.objector).length, 1, 'only the transactional notice reached the objector');
  });
});
