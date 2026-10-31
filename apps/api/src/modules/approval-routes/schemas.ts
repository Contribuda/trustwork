import { z } from 'zod';
import { IdempotencyKeySchema, IdSchema, NonNegativeMoneySchema, RevisionSchema, ShortTextSchema } from '../../deps/contracts.js';
import { ActivateApprovalRouteCommandSchema, ApprovalSubjectKindSchema, DecideApprovalCommandSchema, DelegateApprovalsCommandSchema, DraftApprovalRouteCommandSchema } from './deps.js';

/**
 * HTTP bodies: the frozen supply commands plus the actor (a person on their own authority, or their agent under a
 * mandate). For the human-only commands (decide, activate) the actor is accepted only so that an agent request is
 * refused explicitly (`403 access.mandate_scope`, reason `human_only`) instead of being mistaken for the person.
 */
export const ApprovalActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
const actor = { actor: ApprovalActorInputSchema.default({ via: 'person' }) };
export const DraftRouteBodySchema = DraftApprovalRouteCommandSchema.extend(actor);
export const ActivateRouteBodySchema = ActivateApprovalRouteCommandSchema.extend(actor);
export const DecideBodySchema = DecideApprovalCommandSchema.extend(actor);
export const WithdrawBodySchema = z.strictObject({ expectedRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema, ...actor });
/** The contract command plus the optional limit of the data model (`approval_delegation.limit`); `expectedRevision` of a new delegation is ignored. */
export const DelegateBodySchema = DelegateApprovalsCommandSchema.extend({ limit: NonNegativeMoneySchema.nullable().default(null), ...actor });
export const RevokeDelegationBodySchema = z.strictObject({ reason: ShortTextSchema, expectedRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema, ...actor });

export const RoutesQuerySchema = z.strictObject({ subjectKind: ApprovalSubjectKindSchema.optional() });
export const RequestsQuerySchema = z.strictObject({
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'withdrawn', 'expired', 'superseded']).optional(),
  mine: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const IdParamsSchema = z.strictObject({ id: z.uuid() });
