import { z } from 'zod';
import { DigestSchema, IdSchema, MoneySchema, RegionCodeSchema, RevisionSchema, ShortTextSchema } from '../../deps/contracts.js';
import { BidLevelSheetPayloadSchema, DraftBidLevelSheetCommandSchema, ElectronicRecordsConsentSchema, ExecuteAwardCommandSchema, KeySchema, NotifyOutcomesCommandSchema, ProposeAwardCommandSchema } from './deps.js';

/**
 * HTTP bodies: the frozen supply commands (PRC-000) plus the actor (the person on their own authority, or their agent
 * under a mandate). Eligibility rules are defined here: they are the buyer's private constraints of this module, read
 * by nobody else, so they stay out of the shared contracts until a second reader exists.
 */
export const SourcingActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
const actor = { actor: SourcingActorInputSchema.default({ via: 'person' }) };

export const IdParamsSchema = z.strictObject({ id: IdSchema });

export const EligibilityRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('region'), regions: z.array(RegionCodeSchema).min(1).max(50) }),
  z.strictObject({ kind: z.literal('screening_clear') }),
  z.strictObject({ kind: z.literal('licence_category'), category: KeySchema }),
  z.strictObject({ kind: z.literal('insurance_minimum'), amount: MoneySchema }),
  z.strictObject({ kind: z.literal('prequalification_section'), section: KeySchema }),
]);
export type EligibilityRule = z.infer<typeof EligibilityRuleSchema>;

export const SaveEligibilityBodySchema = z.strictObject({ rules: z.array(EligibilityRuleSchema).max(30), expectedRevision: RevisionSchema.nullable(), ...actor });
export const DraftSheetBodySchema = DraftBidLevelSheetCommandSchema.extend(actor);
export const SaveSheetBodySchema = z.strictObject({ payload: BidLevelSheetPayloadSchema, expectedRevision: RevisionSchema, ...actor });
export const FreezeSheetBodySchema = z.strictObject({ digest: DigestSchema, expectedRevision: RevisionSchema, ...actor });
/** `expectedRevision` is the RFQ's on a proposal and on notices, the award's on execution and cancellation. */
export const ProposeAwardBodySchema = ProposeAwardCommandSchema.extend(actor);
export const ExecuteAwardBodySchema = ExecuteAwardCommandSchema.extend({ electronicRecords: ElectronicRecordsConsentSchema.nullable(), ...actor });
export const CancelAwardBodySchema = z.strictObject({ reason: ShortTextSchema, expectedRevision: RevisionSchema, ...actor });
export const NotifyOutcomesBodySchema = NotifyOutcomesCommandSchema.extend(actor);
