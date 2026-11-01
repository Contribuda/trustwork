import { z } from 'zod';

/** Internal staff routing evidence, never a participant or counterparty projection. */
export const AppealAssignmentViewSchema = z.strictObject({
  appealId: z.uuid(), originalDecisionId: z.uuid(), reviewerId: z.uuid().nullable(), assignedAt: z.iso.datetime(),
});
