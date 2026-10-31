import { z } from 'zod';
import { PartySchema } from '../access.js';
import { IdSchema, ShortTextSchema, TimestampSchema } from '../common/ids.js';
import { UnitCodeSchema } from '../common/quantity.js';
import { ExactFactorSchema } from '../common/units.js';
import { VersionNumberSchema } from '../common/version.js';
import { EvidenceRefsSchema, KeySchema, MaterialRefSchema, StepTermsSchema, transitionGuard } from './common.js';

/**
 * Equivalence rules, product unit conversions and substitutions (PRC-006). Equivalent is not approved: using another
 * product than specified always needs a substitution request decided by people through the approval route.
 */

export const AttributeConditionSchema = z.strictObject({
  attribute: KeySchema,
  op: z.enum(['eq', 'gte', 'lte', 'in']),
  values: z.array(z.string().min(1).max(120)).min(1).max(20),
}).refine((c) => c.op === 'in' || c.values.length === 1, { message: 'only `in` takes several values', path: ['values'] });

/** A rule cites its basis (a standard or a specification section); it never claims code compliance on its own. */
export const EquivalenceBasisSchema = z.strictObject({ kind: z.enum(['standard', 'specification_section', 'manufacturer_data']), citation: ShortTextSchema, sourceUrl: z.url().nullable() });

export const EquivalenceRuleVersionSchema = z.strictObject({
  id: IdSchema,
  scope: z.enum(['hub', 'company']),
  hubId: IdSchema.nullable(),
  companyId: IdSchema.nullable(),
  version: VersionNumberSchema,
  payload: z.strictObject({
    stepTerms: StepTermsSchema,
    productRefs: z.array(MaterialRefSchema).max(100),
    attributeConditions: z.array(AttributeConditionSchema).min(1).max(30),
    basis: EquivalenceBasisSchema,
  }).refine((p) => p.stepTerms.length > 0 || p.productRefs.length > 0, { message: 'a rule names step terms or products', path: ['stepTerms'] }),
  status: z.enum(['draft', 'released', 'retired']),
  releasedBy: IdSchema.nullable(),
}).refine((r) => (r.scope === 'hub') === (r.hubId !== null) && (r.scope === 'company') === (r.companyId !== null), { message: 'hub rules name a hub, company rules a company', path: ['scope'] })
  .refine((r) => (r.status === 'draft') === (r.releasedBy === null), { message: 'released rules record who released them', path: ['releasedBy'] });
export type EquivalenceRuleVersion = z.infer<typeof EquivalenceRuleVersionSchema>;

/** Packaging conversion (a 94 lb bag, a pallet of 60 bags). Exact factor and a required source; without a source nothing converts. */
export const ProductUnitConversionSchema = z.strictObject({
  id: IdSchema,
  subject: MaterialRefSchema,
  fromUnit: UnitCodeSchema,
  toUnit: UnitCodeSchema,
  factor: ExactFactorSchema,
  sourceRef: ShortTextSchema,
  verification: z.enum(['sourced', 'claimed', 'reviewed']),
}).refine((c) => c.fromUnit !== c.toUnit, { message: 'a conversion changes the unit', path: ['toUnit'] });

export const SubstitutionStatusSchema = z.enum(['proposed', 'in_approval', 'approved', 'rejected', 'withdrawn']);
export type SubstitutionStatus = z.infer<typeof SubstitutionStatusSchema>;
export const SUBSTITUTION_TRANSITIONS: Readonly<Record<SubstitutionStatus, readonly SubstitutionStatus[]>> = {
  proposed: ['in_approval', 'withdrawn'], in_approval: ['approved', 'rejected', 'withdrawn'], approved: [], rejected: [], withdrawn: [],
};
export const substitutionTransitionAllowed = transitionGuard(SUBSTITUTION_TRANSITIONS);

export const SubstitutionRequestSchema = z.strictObject({
  id: IdSchema,
  context: z.strictObject({ kind: z.enum(['rfq', 'order', 'requisition']), id: IdSchema }),
  originalLineRef: KeySchema,
  proposed: MaterialRefSchema,
  evidenceRefs: EvidenceRefsSchema.min(1),
  proposedBy: PartySchema,
  /** Where the project has a designer of record, that person decides through the route as well. */
  designerPersonId: IdSchema.nullable(),
  approvalRequestId: IdSchema.nullable(),
  status: SubstitutionStatusSchema,
  reuseScope: z.enum(['none', 'project', 'company']).nullable(),
  validUntil: TimestampSchema.nullable(),
}).refine((s) => s.status === 'proposed' || s.status === 'withdrawn' || s.approvalRequestId !== null, { message: 'a decision goes through the approval route', path: ['approvalRequestId'] })
  .refine((s) => s.reuseScope === null || s.reuseScope === 'none' || s.status === 'approved', { message: 'only an approved substitution becomes an approved equal', path: ['reuseScope'] });
export type SubstitutionRequest = z.infer<typeof SubstitutionRequestSchema>;
