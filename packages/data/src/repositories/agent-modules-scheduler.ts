import { sql } from 'kysely';
import { JobTriggerSchema } from '@trustwork/contracts';
import type { Transaction } from '../pool.js';
import { HubCalendarSchema, nextScheduleOccurrence } from '../../../contracts/src/agent-modules.js';
import { agentJobWorker } from './agent-modules.js';

export interface DueJobsReport { claimed: number; outcomes: Record<string, number> }

/**
 * One pass of the job scheduler (worker side, `trustwork_worker` entry points): claims time-based subscriptions that are
 * due, computes the next occurrence in the trigger's time zone and the hub calendar, and records the firing. The database
 * rechecks the subscription, its mandate, the hub's template and every kill switch at fire time; only `due` emits
 * `agents.job_due`. A schedule whose rule has no further occurrence stops (next due NULL). Idempotent per due time.
 *
 * The paired worker registration consumes typed source signals. A firing remains readiness; only the durable
 * occurrence result reports executed work.
 */
export async function runDueJobs(trx: Transaction, limit = 100): Promise<DueJobsReport> {
  const now = (await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(trx)).rows[0]!.at;
  const due = await agentJobWorker.due(trx, limit);
  const outcomes: Record<string, number> = {};
  for (const job of due) {
    const trigger = JobTriggerSchema.parse(job.trigger);
    const calendar = HubCalendarSchema.parse(job.calendar);
    const next = trigger.kind === 'schedule' ? nextScheduleOccurrence(trigger, new Date(Math.max(now.getTime(), job.due_at.getTime())), job.anchor, calendar, job.on_closed_day) : null;
    const outcome = await agentJobWorker.recordFire(trx, {
      subscriptionId: job.job_subscription_id, cause: trigger.kind === 'deadline' ? 'deadline' : 'schedule', dueAt: job.due_at, nextDueAt: next, hubId: job.hub_id,
    });
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  }
  return { claimed: due.length, outcomes };
}
