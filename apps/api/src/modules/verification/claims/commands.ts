import { z } from 'zod';
import { consoleCommand } from '../../../deps/contracts.js';

/**
 * Commands of the claim routes (CLM-001). Staff commands carry the console base (contract version, idempotency key,
 * staff reason); the claimant's commands are a participant's own and carry only the `Idempotency-Key` header. The
 * vocabularies mirror packages/data/migrations/claims; the database repeats every rule.
 */
export const CLAIM_LEVELS = ['claimed', 'verified'] as const;
export const CLAIM_STATES = ['open', 'waiting', 'disputed', 'approved', 'rejected', 'withdrawn'] as const;

const Id = z.uuid();
const Revision = z.int().min(1);

/** The address of a tie: it counts only as one of the claimant's own verified addresses on the company's domain. */
const Tie = z.strictObject({ kind: z.enum(['invitation_link', 'own_domain_mailbox']), email: z.email().max(254) });
export const SubmitClaimCommandSchema = z.strictObject({ hubId: Id, companyId: Id, level: z.enum(CLAIM_LEVELS), recipeId: Id, tie: Tie.nullable() });
export const WithdrawClaimCommandSchema = z.strictObject({});

export const DecideClaimCommandSchema = consoleCommand({
  expectedRevision: Revision,
  decision: z.enum(['approved', 'rejected']),
  /** The reviewer's own record that a register names the claimant as an officer: the other tie for the claimed level. */
  officerMatch: z.boolean(),
  note: z.string().trim().min(1).max(1000).nullable(),
});
export const ProposeDisputeCommandSchema = consoleCommand({ expectedRevision: Revision, winnerClaimId: Id.nullable(), note: z.string().trim().min(10).max(1000) });
export const ConfirmDisputeCommandSchema = consoleCommand({ expectedRevision: Revision });
export const RevokeHandoverCommandSchema = consoleCommand({ revocationReason: z.string().trim().min(10).max(1000) });
export const BindEvidenceCommandSchema = consoleCommand({ checkIds: z.array(Id).min(1).max(12) });
export const ClaimSettingsCommandSchema = consoleCommand({ waitingDays: z.int().min(1).max(30), coolingDays: z.int().min(1).max(30) });

export const ClaimListQuerySchema = z.strictObject({ state: z.enum(CLAIM_STATES).optional() });
export const HandoverListQuerySchema = z.strictObject({ companyId: Id.optional() });
export const RecipeListQuerySchema = z.strictObject({ hubId: Id });
