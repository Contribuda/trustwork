import { z } from 'zod';
import { CategoryCodeSchema, IdempotencyKeySchema, IdSchema, NameSchema, RegionCodeSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from '../../deps/contracts.js';
import {
  CounterpartyIdentifierSchema, DraftSupplierAssessmentCommandSchema, EvidenceRefsSchema, ExternalCounterpartySchema, KeySchema, MaintainSupplierCommandSchema, OnboardingItemSchema,
  RecordSupplierAssessmentCommandSchema, SupplierStatusSchema,
} from './deps.js';

/**
 * HTTP bodies: the frozen supply commands (PRC-000) plus the actor (the person on their own authority, or their agent
 * under a mandate) and the record details the command leaves to the module. Nothing here is free text that could
 * authorize anything: notes and imported cells are data.
 */
export const SupplierActorInputSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('person') }),
  z.strictObject({ via: z.literal('agent'), mandateId: IdSchema }),
]);
const actor = { actor: SupplierActorInputSchema.default({ via: 'person' }) };

/** Record details; on a change, an omitted field keeps its current value. */
const details = {
  categories: z.array(CategoryCodeSchema).max(50).optional(),
  regions: z.array(RegionCodeSchema).max(50).optional(),
  internalNotes: TextSchema.nullable().optional(),
  defaultPaymentTerms: ShortTextSchema.nullable().optional(),
  onboarding: z.array(OnboardingItemSchema).max(50).optional(),
};
/**
 * `procurement.maintain_supplier`: `supplierRecordId: null` adds a record (its `expectedRevision` is ignored); an id
 * changes it. A different `link` on an existing record is the move to the claimed company (only `kind: company`).
 */
export const MaintainSupplierBodySchema = MaintainSupplierCommandSchema.extend({ ...details, ...actor });

const ContactSchema = ExternalCounterpartySchema.shape.contacts.element;
export const CounterpartyFieldsSchema = z.strictObject({
  name: NameSchema,
  identifiers: z.array(CounterpartyIdentifierSchema).max(10).default([]),
  contacts: z.array(ContactSchema).max(20).default([]),
});
export const CreateCounterpartyBodySchema = CounterpartyFieldsSchema.extend({ ...actor });
/** A change; an omitted field keeps its current value. */
export const UpdateCounterpartyBodySchema = z.strictObject({
  name: NameSchema.optional(),
  identifiers: z.array(CounterpartyIdentifierSchema).max(10).optional(),
  contacts: z.array(ContactSchema).max(20).optional(),
  expectedRevision: RevisionSchema,
  idempotencyKey: IdempotencyKeySchema.optional(),
  ...actor,
});

export const AssessmentScoreSchema = z.strictObject({ criterion: KeySchema, value: z.int().min(0).max(5), evidenceRefs: EvidenceRefsSchema });
/** The contract draft command plus the scores (a draft is created with its scores; recording freezes them). */
export const DraftAssessmentBodySchema = DraftSupplierAssessmentCommandSchema.extend({ scores: z.array(AssessmentScoreSchema).min(1).max(30), ...actor })
  .refine((b) => b.period.to >= b.period.from, { message: 'the period ends on or after its start', path: ['period', 'to'] });
export const RecordAssessmentBodySchema = RecordSupplierAssessmentCommandSchema.extend({ ...actor });
export const RespondBodySchema = z.strictObject({ response: z.string().trim().min(1).max(2000), expectedRevision: RevisionSchema, idempotencyKey: IdempotencyKeySchema.optional(), ...actor });

/** CSV is sent as text, XLSX as base64; both stay within the API body limit (256 KiB). */
export const ImportBodySchema = z.strictObject({
  file: z.discriminatedUnion('format', [
    z.strictObject({ format: z.literal('csv'), text: z.string().min(1).max(200_000) }),
    z.strictObject({ format: z.literal('xlsx'), base64: z.string().min(1).max(240_000).regex(/^[A-Za-z0-9+/=\s]+$/) }),
  ]),
  /** Preview: validate every row and report what would happen, create nothing. */
  dryRun: z.boolean().default(false),
  ...actor,
});

export const IdParamsSchema = z.strictObject({ id: z.uuid() });
export const SuppliersQuerySchema = z.strictObject({ status: SupplierStatusSchema.optional(), limit: z.coerce.number().int().min(1).max(100).optional() });
export const LimitQuerySchema = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional() });

/**
 * What a supplier sees of an assessment a buyer chose to share: the assessment and the buying company, nothing of the
 * buyer's record (status, notes, payment terms, onboarding) and nothing about other suppliers. Layer `shared_party`.
 */
export const SharedAssessmentViewSchema = z.strictObject({
  audience: z.literal('shared_party'),
  id: IdSchema,
  buyerCompanyId: IdSchema,
  period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  criteriaVersion: z.int().min(1),
  scores: z.array(AssessmentScoreSchema),
  supplierResponse: TextSchema.nullable(),
  respondedAt: TimestampSchema.nullable(),
  assessedAt: TimestampSchema,
  revision: RevisionSchema,
});
export type SharedAssessmentView = z.infer<typeof SharedAssessmentViewSchema>;
