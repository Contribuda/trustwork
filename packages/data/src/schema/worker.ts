import type { ColumnType, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';
import type { GeneratedTimestamp, Timestamp } from './foundation.js';

/**
 * Worker module (REL-001, packages/data/migrations/worker): scheduler state for the maintenance tasks run by
 * apps/worker. The migration also partitions audit_event and outbox_event by month; their columns are unchanged and
 * stay mirrored in foundation.ts (partitions are storage, not tables of the model).
 */
export type ScheduleOutcome = 'succeeded' | 'failed';
export interface WorkerScheduleTable {
  task: string;
  next_at: GeneratedTimestamp;
  last_started_at: Timestamp | null;
  last_finished_at: Timestamp | null;
  last_outcome: ScheduleOutcome | null;
  last_error: string | null;
  last_worker: string | null;
  run_count: ColumnType<string, string | number | undefined, string | number>;
  failure_count: ColumnType<string, string | number | undefined, string | number>;
  updated_at: GeneratedTimestamp;
}
export type WorkerSchedule = Selectable<WorkerScheduleTable>;

export interface WorkerDatabase {
  worker_schedule: WorkerScheduleTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends WorkerDatabase {}
}

const columns = columnsOf<WorkerDatabase>();
export const TABLE_COLUMNS: TableColumns<WorkerDatabase> = {
  worker_schedule: columns('worker_schedule', ['task', 'next_at', 'last_started_at', 'last_finished_at', 'last_outcome', 'last_error', 'last_worker', 'run_count', 'failure_count', 'updated_at']),
};
