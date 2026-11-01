import { writeFile } from 'node:fs/promises';
import { createPool } from '@trustwork/data';
import { consumePrivacyPropagation } from '../../../apps/worker/src/privacy/propagation.js';
process.once('message', (input: { connectionString: string; id: string; receiptPath: string }) => {
  const pool = createPool({ connectionString: input.connectionString, max: 1 });
  consumePrivacyPropagation(pool, input.id, {
    target: 'retrieval', reconcile: async () => ({ state: 'unknown' }),
    apply: async (instruction) => {
      await writeFile(input.receiptPath, JSON.stringify({ id: instruction.id, digest: instruction.digest, receipt: 'synthetic-applied' }), { flag: 'wx' });
      process.send?.({ applied: true });
      await new Promise(() => undefined);
      return { receipt: 'unreachable' };
    },
  }).catch((error: Error) => { process.send?.({ error: error.message }); process.exitCode = 1; }).finally(() => pool.end());
});
