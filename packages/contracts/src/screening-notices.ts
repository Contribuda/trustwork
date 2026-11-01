import { z } from 'zod';

/** Internal staff routing evidence, never a participant or counterparty projection. */
export const AppealAssignmentViewSchema = z.strictObject({
  appealId: z.uuid(), originalDecisionId: z.uuid(), reviewerId: z.uuid().nullable(), assignedAt: z.iso.datetime(),
  version: z.number().int().positive(),
  status: z.enum(['assigned', 'unassigned', 'unavailable', 'closed']),
});

/** Routing changes confer no decision authority; the existing appeal decision API remains authoritative. */
export const ReassignScreeningAppealCommandSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  reviewerId: z.uuid().nullable(),
  reason: z.string().trim().min(1).max(500),
});
