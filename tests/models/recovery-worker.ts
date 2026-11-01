import { createPool, withPrincipal } from '@trustwork/data';
import { computeDigest } from '@trustwork/contracts';
import type pg from 'pg';
import type { ModelCall, ModelRuntimeBinding } from '../../packages/contracts/src/models.js';
import { assistantModelTurns } from '../../packages/data/src/repositories/assistant-model.js';
import { ModelGateway, reconcileModelOperation } from '../../apps/api/src/modules/models/gateway.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { PostgresModelCallStore, PostgresModelReceiptStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { RuntimeModelAuthority } from '../../apps/api/src/modules/models/runtime-authority.js';
import { FakeModelRegistry } from '../../apps/api/src/modules/models/ports.js';
import { syntheticGovernance } from './durable-helpers.js';

export type RecoveryWorkerConfig = {
  db: pg.PoolConfig;
  call: ModelCall;
  binding: ModelRuntimeBinding;
  key: string;
  text: string;
  mode: 'prepare_die' | 'before_store' | 'before_admit' | 'after_admit' | 'recover';
};
const send = (message: object) => new Promise<void>((resolve) => process.send?.(message, () => resolve()));
const pause = async () => {
  const resumed = new Promise<void>((resolve) => process.once('message', () => resolve()));
  await send({ paused: true });
  await resumed;
};
process.once('message', async (config: RecoveryWorkerConfig) => {
  globalThis.fetch = async () => {
    throw new Error('network disabled in fake recovery test');
  };
  const pool = createPool({ ...config.db, max: 1 });
  const principal = {
    personId: config.call.principalId,
    authzEpoch: config.binding.authzEpoch,
  };
  let calls = 0;
  try {
    const registry = new FakeModelRegistry();
    for (const id of config.call.allowedConnections)
      registry.register(id, {
        mode: 'fake',
        async invoke() {
          calls++;
          return { kind: 'unknown' };
        },
        async reconcile() {
          return { kind: 'unknown' };
        },
      });
    if (config.mode === 'recover') {
      const result = await reconcileModelOperation(
        new PostgresModelReceiptStore(pool, principal, config.binding),
        registry,
        config.call.operationId,
        principal.personId,
      );
      await send({ outcome: result.outcome, calls });
      return;
    }
    const prepared = await withPrincipal(pool, principal, (trx) =>
      assistantModelTurns.begin(trx, config.key, computeDigest({ text: config.text }).value, config.text),
    );
    const call = {
      ...config.call,
      operationId: prepared.turn.id,
      runId: prepared.turn.run_id,
    };
    await send({ turn: prepared.turn, call });
    if (config.mode === 'prepare_die') process.exit(70);
    const store = new PostgresModelCallStore(pool, principal, config.binding);
    if (config.mode === 'before_store') {
      const begin = store.begin.bind(store);
      store.begin = async (...args) => {
        await pause();
        return begin(...args);
      };
    } else {
      const admit = store.admit.bind(store);
      store.admit = async (...args) => {
        if (config.mode === 'after_admit') {
          const admitted = await admit(...args);
          await pause();
          return admitted;
        }
        await pause();
        return admit(...args);
      };
    }
    const gateway = new ModelGateway(
      new KeysRouteResolver(pool),
      new RuntimeModelAuthority(pool, principal, config.binding, syntheticGovernance),
      store,
      registry,
    );
    const result = await gateway.call(call);
    await send({ outcome: result.outcome, calls });
  } catch (error) {
    await send({
      calls,
      error: (error as { hint?: string; code?: string }).hint ?? (error as { code?: string }).code ?? 'test_failure',
    });
  } finally {
    await pool.end();
    process.disconnect?.();
  }
});
