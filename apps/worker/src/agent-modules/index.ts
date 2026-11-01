import { sql } from 'kysely';
import { z } from 'zod';
import type { DataPool } from '@trustwork/data';
import { runDueJobs } from './scheduler.js';
import { inTransaction } from '../db.js';
import type { HandlerRegistry } from '../handlers.js';
import type { ScheduledTask } from '../scheduler.js';

const OccurrenceReferenceSchema = z.strictObject({ occurrenceId: z.uuid() });
const SignalSchema = z.strictObject({ signalId: z.uuid() });

/** Register the source consumer and leased local handlers together; no provider or impersonated session. */
export function registerAgentOccurrences(registry: HandlerRegistry): void {
  registry.onOutbox({
    name: 'agents.job_due', type: 'agents.job_due',
    async handle(event, { trx }) {
      if (!/^[1-9][0-9]*$/.test(event.id)) throw new Error('invalid durable event identity');
      await sql`SELECT trustwork.agent_modules_consume_schedule(${event.id}::bigint)`.execute(trx);
    },
  });
  registry.onOutbox({
    name: 'agents.occurrence_source', type: 'agents.occurrence_source', parse: SignalSchema.parse,
    async handle(event, { trx }) {
      if (event.aggregateKind !== 'agent_occurrence_signal' || event.aggregateId !== event.payload.signalId || event.revision !== 1) throw new Error('invalid source envelope');
      await sql`SELECT trustwork.agent_modules_consume_signal(${event.payload.signalId}::uuid)`.execute(trx);
    },
  });
  registry.onJob({
    kind: 'agents.start_occurrence', mode: 'transactional', parse: OccurrenceReferenceSchema.parse,
    async run({ trx, job, payload }) {
      await sql`SELECT trustwork.agent_modules_start_occurrence(${payload.occurrenceId}::uuid, ${job.id}::uuid, ${job.fencing_token}::bigint)`.execute(trx);
    },
  });
  registry.onJob({
    kind: 'agents.execute_occurrence', mode: 'transactional', parse: OccurrenceReferenceSchema.parse,
    async run({ trx, job, payload }) {
      await sql`SELECT trustwork.agent_modules_execute_occurrence(${payload.occurrenceId}::uuid, ${job.id}::uuid, ${job.fencing_token}::bigint)`.execute(trx);
    },
  });
}

/** Installed with the consumer: source discovery never claims that a run completed. */
export function agentOccurrencesTask(pool: DataPool): ScheduledTask {
  return {
    name: 'agents.occurrences', intervalSeconds: 30,
    run: () => inTransaction(pool, async (trx) => {
      const schedules = await runDueJobs(trx);
      const deadlines = await sql<{ count: number }>`SELECT trustwork.agent_modules_deadline_tick(100) AS count`.execute(trx);
      return { schedules: schedules.claimed, deadlines: deadlines.rows[0]?.count ?? 0 };
    }),
  };
}
