import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withMaintenance, withPrincipal } from '@trustwork/data';
import { FakeMailTransport, mailConfigFromEnv, registerMail, type MailTransport } from '../../apps/worker/src/mail/index.js';
import { HandlerRegistry, Metrics, silentLogger, Worker } from '../../apps/worker/src/index.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { principalFor } from '../data/helpers/seed.js';
import { gate, provisionWorkerDatabase, waitFor } from '../worker/helpers/worker-db.js';
import { drain } from '../worker/mail/helpers/stack.js';

// Outside the test: waiting for a shared cluster slot does not count against its timeout.
const env = await provisionWorkerDatabase('privacy_objection_any_address');

/**
 * PRV-001: an objection belongs to the person. The send path reads it for the holder of the address, so an address
 * verified after the objection receives no non-transactional mail, while transactional notices still go. Real worker,
 * real PostgreSQL, fake transport, and the objection through the person's own command under the runtime role.
 */
test('PRV objection: the send path respects the person whatever the address', { skip: env ? false : SKIP_REASON, timeout: 120_000 }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const admin = env.db.admin; const pool = env.workerPool(6);
  const config = mailConfigFromEnv({ MAIL_TRANSPORT: 'fake', MAIL_PUBLIC_ORIGIN: 'https://hub.example.invalid', MAIL_RECIPIENT_LIMIT_PER_HOUR: '100' });
  const makeWorker = (transport: MailTransport, concurrency = 3) => {
    const registry = new HandlerRegistry(); registerMail(registry, { pool, config, transport, log: silentLogger, metrics: new Metrics() });
    const worker = new Worker({ pool, registry, config: { concurrency }, tasks: () => [] });
    t.after(() => worker.stop(200)); return worker;
  };
  const address = (label: string) => `synthetic-${label}-${randomUUID()}@example.invalid`;
  const person = () => withMaintenance(admin, async (trx) => (await trx.insertInto('person').values({ display_name: 'Synthetic Objecting Person' }).returning('id').executeTakeFirstOrThrow()).id);
  const bind = (id: string, email: string, verified = true, primary = false) => withMaintenance(admin, (trx) => trx.insertInto('email_binding')
    .values({ person_id: id, email_normalized: email, is_primary: primary, verified_at: verified ? new Date() : null }).execute());
  /** As the person, under the runtime role: the path sign-up, verification and address changes write through. */
  const addOwnAddress = async (id: string, email: string) => withPrincipal(env.apiPool, await principalFor(admin, id), async (trx) => {
    const row = await trx.insertInto('email_binding').values({ person_id: id, email_normalized: email, is_primary: false }).returning('id').executeTakeFirstOrThrow();
    await trx.updateTable('email_binding').set({ verified_at: new Date() }).where('id', '=', row.id).execute();
  });
  const preferences = { optOutSale: false, optOutSharing: false, limitSensitive: false, gpc: false };
  const object = async (id: string) => withPrincipal(env.apiPool, await principalFor(admin, id), (trx) => privacy.preference(trx, { ...preferences, directMarketingObjection: true }));
  const queue = (to: string, transactional: 'true' | 'false' = 'false') => withMaintenance(admin, async (trx) => {
    const id = randomUUID();
    await trx.insertInto('mail_delivery').values({ id, recipient: to, recipient_hash: mailAddressHash(to), template: 'notification', locale_preferences: ['en'],
      params: JSON.stringify({ subject: 'Synthetic notice', body: 'Synthetic body', path: '/app/privacy', transactional }) }).execute();
    await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: id, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
    return id;
  });
  const state = async (id: string) => (await admin.query<{ state: string }>('SELECT state FROM trustwork.mail_delivery WHERE id=$1', [id])).rows[0]!.state;

  await t.test('an address verified after the objection receives no marketing; transactional notices still reach it', async () => {
    const objector = await person();
    const first = address('first'); await bind(objector, first, true, true);
    await object(objector);
    // Under the runtime role, as the real flow does it: an objection changes nothing about adding or verifying an address.
    const later = address('later'); await addOwnAddress(objector, later);
    assert.equal((await admin.query('SELECT 1 FROM trustwork.privacy_suppression WHERE digest=$1', [mailAddressHash(later)])).rowCount, 0, 'nothing suppresses the new address by itself');
    const other = await person(); const theirs = address('other'); await bind(other, theirs, true, true);
    const marketing = await queue(later); const notice = await queue(later, 'true'); const old = await queue(first); const unrelated = await queue(theirs);
    const fake = new FakeMailTransport();
    await drain(makeWorker(fake));
    assert.equal(await state(marketing), 'suppressed');
    assert.equal(await state(old), 'suppressed');
    assert.equal(await state(notice), 'sent', 'an objection is not an unsubscribe from transactional notices');
    assert.equal(await state(unrelated), 'sent', 'somebody else\'s mail is unaffected');
    assert.deepEqual(fake.sent.map((m) => m.to).sort(), [later, theirs].sort());
  });

  await t.test('the same for an address bound before the objection and verified after it', async () => {
    const objector = await person();
    const pending = address('pending'); await bind(objector, pending, false, true);
    await object(objector);
    await withMaintenance(admin, (trx) => trx.updateTable('email_binding').set({ verified_at: new Date() }).where('email_normalized', '=', pending).execute());
    const id = await queue(pending);
    const fake = new FakeMailTransport();
    await drain(makeWorker(fake));
    assert.equal(await state(id), 'suppressed'); assert.equal(fake.sent.length, 0);
  });

  await t.test('without an objection the same mail goes out, and an address nobody holds is unchanged', async () => {
    const plain = await person(); const own = address('plain'); await bind(plain, own, true, true);
    const held = await queue(own); const free = await queue(address('unbound'));
    const fake = new FakeMailTransport();
    await drain(makeWorker(fake));
    assert.equal(await state(held), 'sent'); assert.equal(await state(free), 'sent');
  });

  await t.test('an objection waits for a touch in transport to an address it did not list; the next touch is cancelled', async () => {
    const objector = await person();
    const unseen = address('unseen'); await bind(objector, unseen, false, true);
    const entered = gate(); const release = gate();
    const fake = new FakeMailTransport(); let held = false;
    const transport: MailTransport = { name: 'fake', maxDurationMs: 30_000, async send(mail, signal) {
      if (!held) { held = true; entered.open(); await release.promise; }
      return fake.send(mail, signal);
    } };
    const first = await queue(unseen);
    const sending = drain(makeWorker(transport, 1));
    await entered.promise;
    let acknowledged = false;
    const objecting = object(objector).then(() => { acknowledged = true; });
    // The gate opens whatever happens, so a failure here reports instead of holding the worker in transport.
    try {
      await waitFor(async () => (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'")).rows[0]!.n > 0, 15_000, 'the objection waiting on the person lock');
      assert.equal(acknowledged, false, 'the objection is not acknowledged while the touch is in transport');
    } finally { release.open(); }
    await sending; await objecting;
    assert.equal(await state(first), 'sent'); assert.equal(fake.sent.length, 1, 'the touch in transport finishes once');
    const second = await queue(unseen);
    await drain(makeWorker(fake));
    assert.equal(await state(second), 'suppressed'); assert.equal(fake.sent.length, 1);
  });

  await t.test('the runtime role still cannot ask the port', async () => {
    await assert.rejects(env.apiPool.query('SELECT trustwork.privacy_marketing_allowed($1)', ['a'.repeat(64)]), /permission denied/);
  });

  await t.test('an objection leaves identity alone: the binding table has only its own indexes, and identity mail still goes', async () => {
    const indexes = await admin.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='trustwork' AND tablename='email_binding' AND indexdef ~ 'comms_mail_hash'");
    assert.deepEqual(indexes.rows, [], 'an expression index would make every runtime write of an address need EXECUTE on the function');
    const objector = await person(); const own = address('identity'); await bind(objector, own, true, true);
    await object(objector);
    const security = await withMaintenance(admin, async (trx) => {
      const id = randomUUID();
      await trx.insertInto('mail_delivery').values({ id, recipient: own, recipient_hash: mailAddressHash(own), template: 'security_notice', locale_preferences: ['en'], params: JSON.stringify({ event: 'password_changed' }) }).execute();
      await trx.insertInto('outbox_event').values({ aggregate_kind: 'mail_delivery', aggregate_id: id, revision: 1, type: 'mail.requested', payload: '{}' }).execute();
      return id;
    });
    const fake = new FakeMailTransport();
    await drain(makeWorker(fake));
    assert.equal(await state(security), 'sent', 'a security notice is not marketing');
  });
});
