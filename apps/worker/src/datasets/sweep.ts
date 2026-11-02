import type { DataPool } from '@trustwork/data';
import { datasetsWorker } from '../../../../packages/data/src/repositories/datasets.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';

/**
 * Dataset retention and licence expiry (MINE-001). Every hour the worker deletes records past their retention and every
 * record of a contract dataset whose licence is no longer in force; each deletion leaves a tombstone with a digest of
 * the record key (peers and indexes remove what the tombstones name). Batches of at most 10 000 records per kind; a
 * busy record is skipped and taken on the next tick.
 */
export interface DatasetsSweepDeps { pool: DataPool; log: Logger; now?: () => Date }

export async function sweepDatasets(deps: DatasetsSweepDeps): Promise<Record<string, number>> {
  const counts = await inTransaction(deps.pool, (trx) => datasetsWorker.sweep(trx, (deps.now ?? (() => new Date()))()));
  if (counts.licenceEnded > 0) deps.log('info', 'dataset records deleted after their licence ended', { count: counts.licenceEnded });
  return counts;
}

export function datasetsSweepTask(deps: DatasetsSweepDeps): ScheduledTask {
  return { name: 'datasets.sweep', intervalSeconds: 3600, run: () => sweepDatasets(deps) };
}
