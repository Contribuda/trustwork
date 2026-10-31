import { z } from 'zod';
import { PartySchema } from './access.js';
import { AttachmentRefSchema, IdSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { QuantitySchema } from './common/quantity.js';

/** Minimal execution shapes: a counterparty's claim is never automatically a confirmed fact. */
export const EvidenceStateSchema = z.enum(['asserted', 'confirmed', 'disputed', 'superseded']);
export type EvidenceState = z.infer<typeof EvidenceStateSchema>;

export const DeliveryClaimSchema = z.strictObject({
  id: IdSchema,
  orderId: IdSchema,
  claimant: PartySchema,
  lines: z.array(z.strictObject({ quoteLineId: IdSchema, claimedQuantity: QuantitySchema })).min(1),
  evidence: z.array(AttachmentRefSchema),
  claimedAt: TimestampSchema,
  state: EvidenceStateSchema,
});
export type DeliveryClaim = z.infer<typeof DeliveryClaimSchema>;

export const AcceptanceRecordSchema = z.strictObject({
  id: IdSchema,
  deliveryClaimId: IdSchema,
  acceptedBy: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema }),
  lines: z.array(z.strictObject({ quoteLineId: IdSchema, acceptedQuantity: QuantitySchema, contestedQuantity: QuantitySchema.nullable(), defectNote: ShortTextSchema.nullable() })).min(1),
  acceptedAt: TimestampSchema,
});
export type AcceptanceRecord = z.infer<typeof AcceptanceRecordSchema>;

/** Append-only assertion chain; confirmation is a recorded decision by an authorized actor, not an import. */
export const AssertionSchema = z.strictObject({
  id: IdSchema,
  subject: z.strictObject({ kind: z.string().min(1).max(40), id: IdSchema }),
  predicate: z.string().min(1).max(100),
  claimant: PartySchema,
  state: EvidenceStateSchema,
  evidence: z.array(AttachmentRefSchema),
  supersededBy: IdSchema.nullable(),
  sourceTime: TimestampSchema.nullable(),
  observedAt: TimestampSchema,
});
export type Assertion = z.infer<typeof AssertionSchema>;
