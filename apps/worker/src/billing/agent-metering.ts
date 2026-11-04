import type { DataPool } from '@trustwork/data';
import { creditPacks, meteredSteps } from '../../../../packages/data/src/repositories/agent-usage.js';
import { inTransaction } from '../db.js';
import type { Logger } from '../log.js';
import type { ScheduledTask } from '../scheduler.js';

export const AGENT_METERING_SWEEP_TASK = 'billing.agent_metering_sweep';
/** An admitted step with no outcome after this long lost its lease. */
const STEP_LEASE_SECONDS = 15 * 60;

/**
 * AGT-004 housekeeping. A step that lost its lease becomes `outcome_unknown` and keeps its holds: only a final outcome
 * closes it, so this sweep never releases money. Credit lots entering their reminder period are announced, once each.
 */
export function agentMeteringSweepTask(runtime: { pool: DataPool; log: Logger }, intervalSeconds = 60): ScheduledTask {
  return {
    name: AGENT_METERING_SWEEP_TASK,
    intervalSeconds,
    run: async () => {
      const parked = await inTransaction(runtime.pool, (trx) => meteredSteps.sweep(trx, STEP_LEASE_SECONDS, 200));
      const announced = await inTransaction(runtime.pool, (trx) => creditPacks.noticeSweep(trx, 200));
      if (parked > 0) runtime.log('warn', 'metered steps without an outcome parked for reconciliation', { parked });
      return { parked, announced };
    },
  };
}
