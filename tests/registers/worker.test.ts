import test from 'node:test';
import assert from 'node:assert/strict';
import { approvals } from '../../packages/data/src/repositories/admin.js';
import { sql } from 'kysely';
import { registers } from '../../packages/data/src/repositories/registers.js';
import { fakeRegisterObservations as fakeObservations } from '../../packages/contracts/src/sourced-facts.js';
import { refreshRegisters, runRegisterExpiryWatch } from '../../apps/worker/src/registers/refresh.js';
import { silentLogger } from '../../apps/worker/src/log.js';
import { SKIP_REASON } from '../data/helpers/postgres.js';
import { provisionWorkerDatabase, tx } from '../worker/helpers/worker-db.js';
import { registersWorld } from './helpers.js';

const env = await provisionWorkerDatabase('registers_worker');
const DAY = 86_400_000;

/**
 * REG-001 part 2 on real PostgreSQL: the worker refreshes due fake adapters by re-observing the records they hold (an
 * unchanged record adds nothing, no person is the author), reports a live adapter once per cadence without guessing,
 * and the expiry watch is idempotent. Every person, company, identifier and source is synthetic.
 */
test('REG-001 worker refresh and expiry watch', { skip: env ? false : SKIP_REASON }, async (t) => {
  if (!env) return;
  t.after(() => env.close());
  const worker = env.workerPool(4);
  const world = await registersWorld(env.db.admin, env.apiPool);
  const { w, as, cmd, owner, activeSource } = world;
  const steward = w.people.hubOwner;
  const board = await activeSource();
  const adapter = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'us_ca_cslb_licence_file', board.id, 7));
  await cmd(steward, (trx, ctx) => registers.recordFakeRun(trx, ctx, adapter.id, fakeObservations('us_ca_cslb_licence_file', [{ identifierValue: '8000001' }, { identifierValue: '8000002' }], new Date())));
  const facts = async () => as(steward, (trx) => registers.currentFacts(trx, adapter.id));
  const before = await facts();

  await t.test('a due fake adapter re-observes its records; nothing unchanged is added and no person is the author', async () => {
    const notDue = await refreshRegisters({ pool: worker, log: silentLogger, now: () => new Date(Date.now() + DAY) });
    assert.equal(notDue.refreshed, 0, 'the cadence has not passed');
    const due = await refreshRegisters({ pool: worker, log: silentLogger, now: () => new Date(Date.now() + 8 * DAY) });
    assert.deepEqual([due.refreshed, due.observations], [1, 2]);
    const after = await facts();
    assert.deepEqual(after.map((f) => f.id), before.map((f) => f.id), 'the fake answers the same, so the same facts stay current');
    const total = await owner((trx) => trx.selectFrom('register_fact').select('id').where('adapter_id', '=', adapter.id).execute());
    assert.equal(total.length, 2);
    const again = await refreshRegisters({ pool: worker, log: silentLogger, now: () => new Date(Date.now() + 9 * DAY) });
    assert.equal(again.refreshed, 0, 'refreshed once per cadence');
  });

  await t.test('a live adapter is reported once per cadence and never guessed', async () => {
    const leiSource = await activeSource({ name: 'Synthetic Worker LEI Index', url: 'https://lei.synthetic-worker.invalid/data' });
    const lei = await cmd(steward, (trx, ctx) => registers.bindAdapter(trx, ctx, w.hubId, 'gleif_lei', leiSource.id, 30));
    const credential = await owner(async (trx) => (await trx.insertInto('provider_credential_ref').values({ hub_id: w.hubId, provider: 'synthetic_gleif', adapter: 'gleif_lei', mode: 'live',
      secret_store: 'env', secret_ref: 'env:SYNTHETIC_WORKER_GLEIF', registered_by: steward }).returning('id').executeTakeFirstOrThrow()).id);
    const digest = await as(steward, (trx) => registers.liveDigest(trx, lei.id, lei.revision, credential));
    const request = await cmd(steward, (trx, ctx) => approvals.request(trx, ctx, { action: 'providers.enable_non_fake', scope: world.hub, actionDigest: digest }));
    await cmd(w.people.lead2, (trx, ctx) => approvals.decide(trx, ctx, request.id, 'approve', digest));
    await cmd(steward, (trx, ctx) => registers.goLive(trx, ctx, lei.id, lei.revision, credential, request.id));
    const first = await refreshRegisters({ pool: worker, log: silentLogger, now: () => new Date(Date.now() + 40 * DAY) });
    assert.equal(first.liveWithoutAdapter, 1);
    const second = await refreshRegisters({ pool: worker, log: silentLogger, now: () => new Date(Date.now() + 41 * DAY) });
    assert.equal(second.liveWithoutAdapter, 0);
    assert.deepEqual(await as(steward, (trx) => registers.currentFacts(trx, lei.id)), []);
  });

  await t.test('the expiry watch is idempotent', async () => {
    const first = await runRegisterExpiryWatch({ pool: worker, log: silentLogger });
    const second = await runRegisterExpiryWatch({ pool: worker, log: silentLogger });
    assert.equal(second.reminders, 0);
    assert.ok((first.reminders ?? -1) >= 0);
    await assert.rejects(tx(env.apiPool, (trx) => sql`SELECT trustwork.registers_run_expiry_watch(now())`.execute(trx)), /permission denied/);
  });
});
