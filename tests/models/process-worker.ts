import { DeterministicModel } from '../../apps/api/src/modules/models/fake.js';
// Isolated fake-only process used by durability/cap tests. Configuration travels over IPC, never stdout or argv.
import { createPool, withPrincipal } from '@trustwork/data';
import type pg from 'pg';
import type { ModelCall, ModelRuntimeBinding } from '../../packages/contracts/src/models.js';
import { PostgresModelCallStore } from '../../apps/api/src/modules/models/postgres-store.js';
import { KeysRouteResolver } from '../../apps/api/src/modules/models/keys-route-resolver.js';
import { modelCalls } from '../../packages/data/src/repositories/models.js';
import { computeDigest } from '@trustwork/contracts';

process.once(
  'message',
  async (config: { db: pg.PoolConfig; call: ModelCall; binding: ModelRuntimeBinding; mode: 'begin' | 'before_commit' | 'after_admit' | 'after_effect' }) => {
    globalThis.fetch = async () => {
      throw new Error('network disabled in fake model test');
    };
    const pool = createPool({ ...config.db, max: 1 });
    const principal = { personId: config.call.principalId, authzEpoch: config.binding.authzEpoch };
    try {
      const route = await new KeysRouteResolver(pool).resolve(config.call);
      if (config.mode === 'before_commit') {
        await withPrincipal(pool, principal, async (trx) => {
          const { prompt: _prompt, ...request } = config.call;
          void _prompt;
          await modelCalls.begin(trx, request, config.binding, computeDigest(config.call).value, route, route.candidates[0], 1);
          process.exit(70);
        });
      }
      const store = new PostgresModelCallStore(pool, principal, config.binding, 1);
      const result = await store.begin(config.call, route, route.candidates[0]!);
      if (result.kind === 'dispatch' && config.mode !== 'begin') {
        await store.admit(result.call);
        if (config.mode === 'after_effect') {
          const receipt = await new DeterministicModel().invoke({
            operationId: config.call.operationId,
            model: result.call.candidate,
            prompt: config.call.prompt,
            maxInputTokens: config.call.maxInputTokens,
            maxOutputTokens: config.call.maxOutputTokens,
            signal: new AbortController().signal,
          });
          // Deliver the fake provider receipt outside the application transaction before the dispatching process dies.
          await new Promise<void>((resolve) => process.send?.({ effect: config.call.operationId, receipt }, () => resolve()));
        }
        process.exit(70);
      }
      process.send?.({ kind: result.kind });
    } catch (error) {
      process.send?.({ error: (error as { hint?: string; code?: string }).hint ?? (error as { code?: string }).code ?? 'test_failure' });
    } finally {
      await pool.end();
      process.disconnect?.();
    }
  },
);
