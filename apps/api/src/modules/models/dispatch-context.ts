import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from '../../../../../packages/data/src/pool.js';
import { ModelRefusal } from './ports.js';

const active = new AsyncLocalStorage<Transaction>();
/** Internal callback-only seam: the original-operation store owns this transaction and its lifetime. */
export const withModelDispatchTransaction = <T>(trx: Transaction, invoke: () => Promise<T>): Promise<T> => active.run(trx, invoke);
export function currentModelDispatchTransaction(): Transaction {
  const trx = active.getStore();
  if (!trx) throw new ModelRefusal('callback_authority_unavailable');
  return trx;
}
