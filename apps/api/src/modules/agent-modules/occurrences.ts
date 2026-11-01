import { z } from 'zod';
import { computeDigest, type JobTrigger } from '../../deps/contracts.js';
import { deadlineOccurrences } from './contracts.js';

const Id = z.uuid();
const Revision = z.int().positive();
const Instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s).toISOString());

/** Internal references only. A source identifies work; it never carries authority or executable text. */
export const OccurrenceSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('schedule'), subscriptionRevision: Revision, scheduledAt: Instant }),
  z.strictObject({ kind: z.literal('request'), operationId: Id }),
  z.strictObject({ kind: z.literal('event'), eventId: Id }),
  z.strictObject({ kind: z.literal('goal'), progressId: Id }),
  z.strictObject({ kind: z.literal('deadline'), contextKind: z.enum(['goal', 'project']), contextId: Id, deadlineKey: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/), deadlineRevision: Revision, calendarVersionId: Id, offsetDays: z.int().min(0).max(365) }),
]);
export type OccurrenceSource = z.infer<typeof OccurrenceSourceSchema>;

/** Separate namespaces prevent a request/event UUID or two same-time events from aliasing. */
export function occurrenceKey(subscriptionId: string, source: OccurrenceSource): string {
  return computeDigest({ kind: 'trustwork.agent_occurrence.v1', subscriptionId: Id.parse(subscriptionId), source: OccurrenceSourceSchema.parse(source) }).value;
}

export interface DeadlineProjection {
  contextKind: 'goal' | 'project';
  contextId: string;
  deadlineKey: string;
  revision: number;
  calendarVersionId: string;
  deadline: Date;
  timeZone: string;
}
export interface PendingDeadline {
  key: string;
  source: Extract<OccurrenceSource, { kind: 'deadline' }>;
  dueAt: Date;
}

/** Enumerate every offset, retaining its identity across restart and replacing it on source revision changes. */
export function pendingDeadlines(subscriptionId: string, trigger: Extract<JobTrigger, { kind: 'deadline' }>, projection: DeadlineProjection): PendingDeadline[] {
  return [...new Set(trigger.offsetsDays)].sort((a, b) => b - a).map((offsetDays) => {
    const source = OccurrenceSourceSchema.parse({
      kind: 'deadline', contextKind: projection.contextKind, contextId: projection.contextId, deadlineKey: projection.deadlineKey, deadlineRevision: projection.revision, calendarVersionId: projection.calendarVersionId, offsetDays,
    }) as Extract<OccurrenceSource, { kind: 'deadline' }>;
    const [dueAt] = deadlineOccurrences({ ...trigger, offsetsDays: [offsetDays] }, projection.deadline, projection.timeZone);
    if (!dueAt || !Number.isFinite(dueAt.getTime())) throw new Error('invalid deadline projection');
    return { key: occurrenceKey(subscriptionId, source), source, dueAt };
  });
}

/** Outbox and job payloads expose only a ledger reference. Stored source and authority are reloaded by the worker. */
export const OccurrenceReferenceSchema = z.strictObject({ occurrenceId: Id });
