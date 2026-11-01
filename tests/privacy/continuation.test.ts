import assert from 'node:assert/strict';
import test from 'node:test';
import { withMaintenance } from '@trustwork/data';
import { startHarness, SKIP_REASON } from '../backend/helpers/app.js';
import { privacyWorld } from './helpers.js';
import { gate, provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { privacy } from '../../packages/data/src/repositories/privacy.js';
import { mailAddressHash } from '../../packages/data/src/repositories/mail.js';
import { FakeDropRegistry } from '../../apps/api/src/modules/platform-admin/privacy/registry.js';

test('PRV continuation: public objections and configured fake DROP intake', async (t) => {
  const h = await startHarness('privacy_continuation');
  if (!h) { t.skip(SKIP_REASON); return; }
  t.after(() => h.close());
  await t.test('unregistered objections are idempotent, minimal and cannot reveal or erase a subject', async () => {
    const client = h.client();
    const send = (address: string) => client.post('/v1/privacy/public/marketing-objections', { address }, { idempotencyKey: null });
    const result = await send('synthetic-nonparticipant@example.invalid');
    assert.equal(result.status, 202, JSON.stringify(result.body));
    assert.deepEqual(result.body, { accepted: true });
    assert.deepEqual((await send('synthetic-nonparticipant@example.invalid')).body, result.body);
    assert.deepEqual((await send('synthetic-unknown@example.invalid')).body, result.body);
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.privacy_suppression')).rows[0].n, 2);
    assert.equal((await h.db.admin.query('SELECT count(*)::int AS n FROM trustwork.privacy_replay_receipt')).rows[0].n, 0);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.privacy_suppression'), /permission denied/);
    await assert.rejects(h.pool.query('SELECT trustwork.privacy_marketing_allowed($1)', [mailAddressHash('synthetic-unknown@example.invalid')]), /permission denied/);
    await assert.rejects(h.pool.query('DELETE FROM trustwork.privacy_suppression'), /permission denied/);
    const stored = (await h.db.admin.query('SELECT * FROM trustwork.privacy_suppression')).rows;
    assert.ok(!JSON.stringify(stored).includes('@'));
  });
  const world = await privacyWorld(h);
  const ctx = await world.context(world.people.officer);
  const setup = (country: string, verified: boolean) => withMaintenance(h.db.admin, async (trx) => {
    await trx.insertInto('privacy_country_policy').values({ country, version: 'synthetic-only-v1', review: verified ? 'verified' : 'UNKNOWN',
      sources: JSON.stringify(verified ? ['https://example.invalid/synthetic-pack'] : []), deadline_days: verified ? 3 : null,
      retention_days: verified ? 0 : null, registry_poll_hours: verified ? 6 : null, registry_deadline_days: verified ? 4 : null }).execute();
    return trx.insertInto('data_broker_registration').values({ country, registry: 'fake_drop', registration_ref: 'synthetic-only', last_polled_at: null, next_poll_at: null }).returning('id').executeTakeFirstOrThrow();
  });
  await t.test('UNKNOWN policy and unavailable adapter never invent polling or response deadlines', async () => {
    const registration = await setup('XY', false);
    assert.deepEqual(await new FakeDropRegistry([], false).read(), { status: 'unavailable' });
    assert.deepEqual(await world.as(world.people.officer, (trx) => privacy.registryReceive(trx, ctx, registration.id, [])), { status: 'UNKNOWN', received: 0, nextPollAt: null });
    assert.equal((await h.db.admin.query('SELECT last_polled_at FROM trustwork.data_broker_registration WHERE id=$1', [registration.id])).rows[0].last_polled_at, null);
    await assert.rejects(world.as(world.people.subject, (trx) => privacy.registryReceive(trx, ctx, registration.id, [])));
  });
  await t.test('configured pack governs cadence and deadline; intake is not erasure authority', async () => {
    const registration = await setup('ZZ', true);
    const fake = await new FakeDropRegistry([{ externalRef: 'synthetic-drop-1', contactDigest: mailAddressHash('synthetic-drop@example.invalid') }]).read();
    assert.equal(fake.status, 'available');
    if (fake.status !== 'available') throw new Error('fixture unavailable');
    const poll = () => world.as(world.people.officer, (trx) => privacy.registryReceive(trx, ctx, registration.id, fake.entries));
    const outcomes = await Promise.all([poll(), poll()]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), ['not_due', 'received']);
    const row = (await h.db.admin.query('SELECT * FROM trustwork.privacy_registry_intake WHERE registration_id=$1', [registration.id])).rows[0];
    assert.equal(row.state, 'proof_required');
    assert.equal(row.deadline_at.getTime() - row.received_at.getTime(), 4 * 86400000);
    const reg = (await h.db.admin.query('SELECT * FROM trustwork.data_broker_registration WHERE id=$1', [registration.id])).rows[0];
    assert.equal(reg.next_poll_at.getTime() - reg.last_polled_at.getTime(), 6 * 3600000);
    await h.db.admin.query('UPDATE trustwork.data_broker_registration SET next_poll_at=now() WHERE id=$1', [registration.id]);
    assert.equal((await poll()).received, 0);
    await assert.rejects(h.pool.query('SELECT * FROM trustwork.privacy_registry_intake'), /permission denied/);
  });
});

test('PRV continuation: real restricted worker contact barrier serializes both race orders', async (t) => {
  const env = await provisionWorkerDatabase('privacy_contact_race');
  if (!env) { t.skip(SKIP_REASON); return; }
  t.after(() => env.close());
  const worker = env.workerPool(2);
  await t.test('objection first: a waiting dispatch is denied after commit', async () => {
    const digest = mailAddressHash('synthetic-objection-first@example.invalid');
    const locked = gate(); const release = gate();
    const objection = tx(env.apiPool, async (_trx, client) => {
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [digest]); locked.open(); await release.promise;
    });
    await locked.promise;
    const dispatch = tx(worker, (trx) => privacy.marketingAllowed(trx, digest));
    release.open(); await objection;
    assert.equal(await dispatch, false);
  });
  await t.test('dispatch first: objection cannot acknowledge until the dispatch transaction ends', async () => {
    const digest = mailAddressHash('synthetic-dispatch-first@example.invalid');
    const locked = gate(); const release = gate();
    const dispatch = tx(worker, async (trx) => {
      assert.equal(await privacy.marketingAllowed(trx, digest), true); locked.open(); await release.promise;
    });
    await locked.promise;
    let acknowledged = false;
    const objection = env.apiPool.query('SELECT trustwork.privacy_marketing_object($1)', [digest]).then(() => { acknowledged = true; });
    await env.db.admin.query('SELECT pg_sleep(0.05)');
    assert.equal(acknowledged, false);
    release.open(); await dispatch; await objection;
    assert.equal(await tx(worker, (trx) => privacy.marketingAllowed(trx, digest)), false);
  });
  await t.test('rollback cannot acknowledge an objection; retries converge without a second effect', async () => {
    const digest = mailAddressHash('synthetic-rollback@example.invalid');
    await assert.rejects(tx(env.apiPool, async (_trx, client) => {
      await client.query('SELECT trustwork.privacy_marketing_object($1)', [digest]); throw new Error('synthetic crash before commit');
    }), /synthetic crash/);
    assert.equal(await tx(worker, (trx) => privacy.marketingAllowed(trx, digest)), true);
    await env.apiPool.query('SELECT trustwork.privacy_marketing_object($1)', [digest]);
    await env.apiPool.query('SELECT trustwork.privacy_marketing_object($1)', [digest]);
    assert.equal((await env.db.admin.query('SELECT count(*)::int AS n FROM trustwork.suppression_entry WHERE address_hash=$1', [digest])).rows[0].n, 1);
    assert.equal(await tx(worker, (trx) => privacy.marketingAllowed(trx, digest)), false);
  });
});
