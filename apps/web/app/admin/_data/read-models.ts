import { z } from 'zod';
import { IdSchema, NameSchema, ProviderCapabilitySchema, ProviderModeSchema, ShortTextSchema, TimestampSchema } from '@trustwork/contracts/client';

/**
 * Console read models that only the server renders. They live apart from `schemas.ts` because a client component reaches
 * that module (the approval inbox validates a decision in the browser) and zod schemas are not tree-shaken, so everything
 * there ships to the browser. Keep a schema here unless client code needs it.
 */

const Synthetic = { synthetic: z.boolean() } as const;

/* ---------- Overview ---------- */

export const QUEUE_IDS = ['claims', 'review_items', 'link_proposals', 'reports', 'support_cases', 'grant_requests', 'privacy_requests', 'unknown_outcomes', 'alerts'] as const;
export const QueueIdSchema = z.enum(QUEUE_IDS);
export type QueueId = z.infer<typeof QueueIdSchema>;
export const HEALTH_CHECKS = ['readiness', 'outbox_age', 'dead_letters', 'unknown_outcomes', 'backup_age'] as const;

export const OverviewSchema = z.strictObject({
  hubId: IdSchema,
  queues: z.array(z.strictObject({ id: QueueIdSchema, count: z.int().min(0), nearestDeadline: TimestampSchema.nullable() })),
  /** Queues nobody counted (live: no read for them yet, or the viewer may not make it): the console never says they are empty. */
  uncounted: z.array(QueueIdSchema).optional(),
  /** `null` where nothing records the value (never a guess). */
  compliance: z.strictObject({
    legalDocumentsDue: z.int().min(0).nullable(),
    screeningListAgeDays: z.int().min(0).nullable(),
    expiringSourceLicences: z.int().min(0).nullable(),
    fakeProviders: z.array(ProviderCapabilitySchema).nullable(),
  }),
  /** Health values: minutes for ages, counts otherwise; null when nothing measured it yet (never a guess). */
  health: z.array(z.strictObject({ id: z.enum(HEALTH_CHECKS), state: z.enum(['ok', 'warning', 'failing', 'unknown']), value: z.int().min(0).nullable() })),
  updatedAt: TimestampSchema,
  ...Synthetic,
}).refine((o) => new Set(o.queues.map((q) => q.id)).size === o.queues.length, { message: 'each queue once', path: ['queues'] });
export type Overview = z.infer<typeof OverviewSchema>;

/* ---------- Residency ---------- */

export const ResidencySchema = z.strictObject({
  hubId: IdSchema,
  country: z.string().regex(/^[A-Z]{2}$/),
  regime: z.enum(['us_state_privacy', 'uz_personal_data', 'not_recorded']),
  version: z.int().min(1),
  /** From the active `residency` configuration (HUB-001): the region of the hosting and every country that holds personal data. */
  hostingRegion: z.string().min(1).max(20).nullable().optional(),
  personalDataCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
  note: ShortTextSchema.nullable().optional(),
  services: z.array(z.strictObject({ service: z.enum(['database', 'object_storage', 'backups', 'worker', 'email_relay']), region: z.string().min(1).max(60), country: z.string().regex(/^[A-Z]{2}$/) })),
  subProcessors: z.array(z.strictObject({ name: NameSchema, capability: ProviderCapabilitySchema, mode: ProviderModeSchema, country: z.string().regex(/^[A-Z]{2}$/), privateData: z.boolean() })),
  ...Synthetic,
});
export type Residency = z.infer<typeof ResidencySchema>;
