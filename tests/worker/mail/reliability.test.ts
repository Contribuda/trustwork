import test from 'node:test';
import assert from 'node:assert/strict';
import { jobs, mailAddressHash, outbox, withMaintenance } from '@trustwork/data';
import { REDELIVER_KIND } from '../../../apps/worker/src/index.js';
import { FakeMailTransport, MAIL_DELIVER_KIND, MAIL_ENQUEUE_HANDLER, MAIL_METRICS, submitMailFeedback } from '../../../apps/worker/src/mail/index.js';
import { SKIP_REASON } from '../../data/helpers/postgres.js';
import { EMAILS, seedPersonas } from '../../backend/helpers/personas.js';
import { tx } from '../helpers/worker-db.js';
import { drain, signupBody, startMailStack } from './helpers/stack.js';

const stack = await startMailStack('mail_reliability');

/**
 * MAIL-001 reliability on real PostgreSQL: at most one message per intent under duplicated outbox events, redelivery,
 * duplicate jobs, re-runs and two concurrent workers; bounce and complaint receipts recorded idempotently in
 * inbox_receipt; suppression of hard-bounced and complaining addresses; per-recipient rate limit; expired tokens.
 */
test('MAIL-001 reliability: one message per intent, receipts, suppression and limits', { skip: stack ? false : SKIP_REASON }, async (t) => {
  if (!stack) return;
  t.after(() => stack.close());
  await seedPersonas(stack.harness);
  const admin = stack.env.db.admin;
  const workerPool = stack.env.workerPool(4);
  const deliveryOf = async (address: string) => (await stack.mailbox.lastTo(address))!.id;
  const row = async (id: string) => (await admin.query<{ state: string; job_id: string | null; feedback: string | null; recipient: string | null }>('SELECT state, job_id, feedback, recipient FROM trustwork.mail_delivery WHERE id = $1', [id])).rows[0]!;
  const signup = (address: string) => stack.client().post('/v1/auth/signup', signupBody(address), { idempotencyKey: null });

  await t.test('a duplicated outbox event, a redelivery and an extra job for the same intent send one message', async () => {
    const { worker, metrics } = stack.worker();
    const address = 'duplicate.intent@example.test';
    assert.equal((await signup(address)).status, 202);
    const id = await deliveryOf(address);
    // The same intent appended twice (for example a retried writer) before the relay runs.
    await admin.query("INSERT INTO trustwork.outbox_event (aggregate_kind, aggregate_id, revision, type, payload) VALUES ('mail_delivery', $1, 1, 'mail.requested', '{}')", [id]);
    await drain(worker);
    assert.equal(stack.sink.to(address).length, 1);
    assert.equal(metrics.value(MAIL_METRICS.deliveries[0], { template: '_unknown', result: 'duplicate' }), 1, 'the second event was recognised by its inbox receipt');
    const jobsFor = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.job WHERE kind = 'mail.deliver' AND payload->>'deliveryId' = $1", [id]);
    assert.equal(jobsFor.rows[0]!.n, 1, 'one delivery job per intent');

    // A redelivery of the outbox handler for the same event, and a second delivery job enqueued by hand.
    const event = (await admin.query<{ id: string }>("SELECT id::text FROM trustwork.outbox_event WHERE type = 'mail.requested' AND aggregate_id = $1 ORDER BY id LIMIT 1", [id])).rows[0]!;
    await tx(workerPool, async (trx) => {
      await jobs.enqueue(trx, { kind: REDELIVER_KIND, payload: { eventId: event.id, handler: MAIL_ENQUEUE_HANDLER } });
      await jobs.enqueue(trx, { kind: MAIL_DELIVER_KIND, payload: { deliveryId: id } });
    });
    await drain(worker);
    assert.equal(stack.sink.to(address).length, 1, 'still one message');

    // Re-running the succeeded job itself (an operator re-queues it by mistake in a maintenance session) finds the
    // delivery final and sends nothing.
    const jobId = (await row(id)).job_id!;
    await withMaintenance(admin, (trx) => trx.updateTable('job').set({ state: 'queued', next_at: new Date(Date.now() - 1000) }).where('id', '=', jobId).execute());
    await drain(worker);
    assert.equal(stack.sink.to(address).length, 1, 'a re-run never sends again');
    assert.equal((await row(id)).state, 'sent');
  });

  await t.test('concurrency: two workers draining twenty intents send each exactly once', async () => {
    const addresses = Array.from({ length: 20 }, (_, i) => `concurrent.${i}@example.test`);
    for (const address of addresses) assert.equal((await signup(address)).status, 202);
    const a = stack.worker({ config: { concurrency: 8 } }).worker;
    const b = stack.worker({ config: { concurrency: 8 } }).worker;
    await Promise.all([drain(a), drain(b)]);
    await Promise.all([drain(a), drain(b)]);
    for (const address of addresses) assert.equal(stack.sink.to(address).length, 1, `${address} got exactly one message`);
  });

  await t.test('a permanent refusal at RCPT is a hard bounce: the address is suppressed and never tried again', async () => {
    const { worker } = stack.worker();
    const address = 'gone.away@example.test';
    stack.sink.rejectRecipients.add(address);
    await signup(address);
    await drain(worker);
    const first = await deliveryOf(address);
    assert.equal((await row(first)).state, 'failed');
    assert.equal((await row(first)).feedback, 'hard_bounce');
    const suppression = (await admin.query<{ reason: string; source: string }>('SELECT reason, source FROM trustwork.suppression_entry WHERE address_hash = $1', [mailAddressHash(address)])).rows[0];
    assert.deepEqual(suppression, { reason: 'bounce', source: 'feedback:smtp' });
    const job = (await admin.query<{ state: string }>('SELECT state FROM trustwork.job WHERE id = $1', [(await row(first)).job_id])).rows[0]!;
    assert.equal(job.state, 'dead', 'a permanent refusal is not retried');
    const connections = stack.sink.connections;
    await signup(address); // bound address now: "already registered" notice
    await drain(worker);
    const second = await deliveryOf(address);
    assert.notEqual(second, first);
    assert.equal((await row(second)).state, 'suppressed');
    assert.equal(stack.sink.connections, connections, 'a suppressed address costs no connection');
  });

  await t.test('feedback events: recorded once in inbox_receipt; a hard bounce or a complaint suppresses; a soft bounce does not', async () => {
    const { worker, metrics } = stack.worker();
    const addresses = { soft: 'soft.bounce@example.test', complaint: 'complainer@example.test', hard: 'hard.bounce@example.test' };
    for (const address of Object.values(addresses)) await signup(address);
    await drain(worker);
    const ids = { soft: await deliveryOf(addresses.soft), complaint: await deliveryOf(addresses.complaint), hard: await deliveryOf(addresses.hard) };
    await tx(workerPool, async (trx) => {
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-soft', kind: 'bounce', bounce: 'soft', deliveryId: ids.soft });
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-delivered', kind: 'delivered', deliveryId: ids.complaint });
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-complaint', kind: 'complaint', deliveryId: ids.complaint });
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-hard', kind: 'bounce', bounce: 'hard', deliveryId: ids.hard });
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-hard', kind: 'bounce', bounce: 'hard', deliveryId: ids.hard });
      await submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-unknown', kind: 'delivered', deliveryId: '00000000-0000-4000-8000-000000000000' });
    });
    await drain(worker);
    assert.equal((await row(ids.soft)).feedback, 'soft_bounce');
    assert.equal((await row(ids.complaint)).feedback, 'complaint');
    assert.equal((await row(ids.hard)).feedback, 'hard_bounce');
    const suppressed = async (address: string) => (await admin.query<{ reason: string }>('SELECT reason FROM trustwork.suppression_entry WHERE address_hash = $1', [mailAddressHash(address)])).rows[0]?.reason ?? null;
    assert.equal(await suppressed(addresses.soft), null);
    assert.equal(await suppressed(addresses.complaint), 'complaint');
    assert.equal(await suppressed(addresses.hard), 'bounce');
    assert.equal(metrics.value(MAIL_METRICS.feedback[0], { kind: 'duplicate' }), 1, 'the repeated provider event is a duplicate receipt');
    assert.equal(metrics.value(MAIL_METRICS.feedback[0], { kind: 'unknown_delivery' }), 1);
    const receipts = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM trustwork.inbox_receipt WHERE provider = 'mail.relay' AND event_id = 'evt-hard'");
    assert.equal(receipts.rows[0]!.n, 1);
    // A later "delivered" never downgrades a complaint.
    await tx(workerPool, (trx) => submitMailFeedback(trx, { provider: 'relay', eventId: 'evt-delivered-late', kind: 'delivered', deliveryId: ids.complaint }));
    await drain(worker);
    assert.equal((await row(ids.complaint)).feedback, 'complaint');
  });

  await t.test('per-recipient limit: messages beyond the hourly window are dropped as rate_limited, never queued for later', async () => {
    const { worker } = stack.worker({ mail: { MAIL_RECIPIENT_LIMIT_PER_HOUR: '2' } });
    for (let i = 0; i < 4; i += 1) assert.equal((await stack.client().post('/v1/auth/recovery', { email: EMAILS.boris }, { idempotencyKey: null })).status, 202);
    await drain(worker);
    // Four jobs run concurrently; the per-recipient lock keeps the window exact whichever runs first.
    const states = (await stack.mailbox.to(EMAILS.boris, 'recovery')).map((m) => m.state).sort();
    assert.deepEqual(states, ['rate_limited', 'rate_limited', 'sent', 'sent']);
    assert.equal(stack.sink.to(EMAILS.boris).length, 2);
  });

  await t.test('a token that expired before delivery is never mailed', async () => {
    const { worker } = stack.worker();
    const address = 'late.delivery@example.test';
    await signup(address);
    const id = await deliveryOf(address);
    await admin.query("UPDATE trustwork.mail_delivery SET secret_expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
    await drain(worker);
    assert.equal((await row(id)).state, 'expired');
    assert.equal((await row(id)).recipient, null);
    assert.equal(stack.sink.to(address).length, 0);
  });

  await t.test('the fake transport keeps the same contract: temporary failures retry, unknown outcomes park', async () => {
    const transport = new FakeMailTransport();
    const { worker } = stack.worker({ transport });
    const retry = 'fake.retry@example.test';
    const unknown = 'fake.unknown@example.test';
    transport.failFor(retry, 'temporary');
    transport.failFor(unknown, 'unknown');
    await signup(retry);
    await signup(unknown);
    await drain(worker);
    const retryRow = await row(await deliveryOf(retry));
    const unknownRow = await row(await deliveryOf(unknown));
    assert.equal(retryRow.state, 'pending');
    assert.equal(unknownRow.state, 'sending');
    const states = await admin.query<{ id: string; state: string }>('SELECT id, state FROM trustwork.job WHERE id = ANY($1::uuid[])', [[retryRow.job_id, unknownRow.job_id]]);
    const byId = new Map(states.rows.map((r) => [r.id, r.state]));
    assert.equal(byId.get(retryRow.job_id!), 'queued');
    assert.equal(byId.get(unknownRow.job_id!), 'outcome_unknown');
    assert.equal(transport.to(unknown).length, 1);
    await tx(stack.env.apiPool, (trx) => outbox.append(trx, { aggregate_kind: 'probe', aggregate_id: 'p', revision: 1, type: 'probe.other', payload: {} }));
    await drain(worker);
    assert.equal(transport.to(unknown).length, 1, 'never resent without reconciliation');
  });
});
