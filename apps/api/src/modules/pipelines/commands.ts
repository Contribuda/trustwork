import { z } from 'zod';
import {
  AlertRuleSchema, AutomationLevelSchema, consoleCommand, CronExpressionSchema, PipelineKindSchema, PipelineStepSchema, PipelineVersionSchema, RetryPolicySchema,
  ScheduleSchema,
} from '../../deps/contracts.js';

/**
 * Console commands of the pipeline routes (PIPE-001). Every command carries the console base (contract version,
 * idempotency key, staff reason). A drafted version is checked against the frozen `PipelineVersionSchema` rules
 * (review queue, generated content reviewed, rewrite followed by a similarity check, ingestion names sources,
 * dataset refresh names its dataset) before it reaches the database.
 */
const Id = z.uuid();
const Role = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const CreatePipelineCommandSchema = consoleCommand({ kind: PipelineKindSchema, name: z.string().trim().min(1).max(200) });
export const DraftPipelineVersionCommandSchema = consoleCommand({
  name: z.string().trim().min(1).max(200),
  sourceIds: z.array(Id).max(50),
  datasetId: Id.nullable(),
  steps: z.array(PipelineStepSchema).min(1).max(30),
  automationLevel: AutomationLevelSchema,
  budgetId: Id.nullable(),
});
export type DraftPipelineVersionCommand = z.infer<typeof DraftPipelineVersionCommandSchema>;
export const ActivatePipelineVersionCommandSchema = consoleCommand({});
export const SetPipelineScheduleCommandSchema = consoleCommand({
  expectedRevision: z.int().min(0),
  cron: CronExpressionSchema,
  timeZone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/),
  windows: ScheduleSchema.shape.windows,
  jitterSeconds: z.int().min(0).max(3600),
  quotas: ScheduleSchema.shape.quotas,
  retry: RetryPolicySchema,
  concurrency: z.int().min(1).max(4),
  alerts: z.array(AlertRuleSchema).max(10),
}).refine((c) => c.windows.every((w) => w.from !== w.to), { message: 'a window needs a non-empty span', path: ['windows'] });
export const PauseScheduleCommandSchema = consoleCommand({ expectedRevision: z.int().min(1), pausedReason: z.string().trim().min(1).max(500) });
export const ResumeScheduleCommandSchema = consoleCommand({ expectedRevision: z.int().min(1) });
export const StartRunCommandSchema = consoleCommand({ trigger: z.enum(['manual', 'dry_run', 'backfill']), backfillFrom: z.iso.datetime().nullable() })
  .refine((c) => (c.trigger === 'backfill') === (c.backfillFrom !== null), { message: 'a backfill names where it starts', path: ['backfillFrom'] });
export const CancelRunCommandSchema = consoleCommand({});
export const DecideAlertCommandSchema = consoleCommand({ state: z.enum(['acknowledged', 'resolved']) });
export const SetRoleCapCommandSchema = consoleCommand({ role: Role, currency: z.string().regex(/^[A-Z]{3}$/), dailyCapMinor: z.string().regex(/^(0|[1-9][0-9]{0,15})$/) });

/** The frozen version rules, checked on the drafted content (ids and statuses are placeholders). */
export function versionProblems(kind: z.infer<typeof PipelineKindSchema>, hubId: string, actorId: string, command: DraftPipelineVersionCommand): string[] {
  const placeholder = '00000000-0000-4000-8000-000000000000';
  const parsed = PipelineVersionSchema.safeParse({
    id: placeholder, pipelineId: placeholder, hubId, kind, version: 1, name: command.name, sourceIds: command.sourceIds, datasetId: command.datasetId, steps: command.steps,
    automationLevel: command.automationLevel, budgetId: command.budgetId, scheduleId: null, status: 'draft', draftedBy: actorId, activatedBy: null,
  });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}
