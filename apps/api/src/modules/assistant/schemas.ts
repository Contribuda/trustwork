import { z } from 'zod';
import {
  ApprovalPolicySchema, ApproverRuleSchema, ConditionSchema, DigestSchema, EscalationSchema, GranteeSchema, IdSchema, MandateActionV2Schema, MandateContextSchema, MandateLimitsV2Schema,
  PartySchema, RevisionSchema, TimestampSchema,
} from '../../deps/contracts.js';

/**
 * Request bodies of the assistant routes (AST-001). The mandate fields reuse the frozen MandateV2 pieces of
 * packages/contracts/src/agent-catalog.ts; the server adds the id, the principal, the revision, the status and the
 * first-party confirmation, so a client can never submit a confirmation of its own. Every schema is strict: an
 * `actor` field (agent or connection) is refused on governance routes.
 */
export const MandateDraftSchema = z.strictObject({
  onBehalfOf: PartySchema.nullable(),
  grantee: GranteeSchema,
  moduleKeys: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).min(1).max(50),
  actions: z.array(MandateActionV2Schema).min(1),
  contexts: z.array(MandateContextSchema).min(1).max(200),
  limits: MandateLimitsV2Schema,
  conditions: z.array(ConditionSchema).max(50),
  approvalPolicy: ApprovalPolicySchema,
  approvers: z.array(ApproverRuleSchema).max(5),
  escalation: EscalationSchema,
  validUntil: TimestampSchema,
});
export type MandateDraft = z.infer<typeof MandateDraftSchema>;

export const CreateMandateCommandSchema = z.strictObject({ draft: MandateDraftSchema });
export const ReviseMandateCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, draft: MandateDraftSchema });
export const NarrowMandateCommandSchema = z.strictObject({ expectedRevision: RevisionSchema, reason: z.string().trim().min(1).max(300) });
/** The person confirms exactly the proposal they were shown: its digest is repeated. */
export const ConfirmProposalCommandSchema = z.strictObject({ digest: DigestSchema });
export const DecideCommandSchema = z.strictObject({ digest: DigestSchema });
export const DeclineCommandSchema = z.strictObject({ reason: z.string().trim().min(1).max(300).nullable() });
export const CancelRunCommandSchema = z.strictObject({ reason: z.string().trim().min(1).max(300).nullable() });
export const ConversationCommandSchema = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export const BacklogStatusCommandSchema = z.strictObject({ status: z.enum(['accepted', 'dismissed', 'done']), expectedRevision: RevisionSchema });
export const IdParamsSchema = z.strictObject({ id: IdSchema });
