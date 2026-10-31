import { z } from 'zod';
import { STAFF_ROLES } from './admin.js';
import { IdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { GrantAudienceSchema, ProjectionLayerSchema } from './common/projection.js';
import { CompanyPermissionSchema } from './company.js';

/** Exactly one person XOR one company. Used for ownership and for party identity in commercial objects. */
export const PartySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('person'), id: IdSchema }),
  z.strictObject({ kind: z.literal('company'), id: IdSchema }),
]);
export type Party = z.infer<typeof PartySchema>;
/** Ownership alias kept for existing importers (`Owner` predates the freeze). */
export const OwnerSchema = PartySchema;
export type Owner = Party;
export function sameParty(a: Party, b: Party): boolean {
  return a.kind === b.kind && a.id === b.id;
}

export const CAPABILITIES = [
  'read.public', 'read.shared', 'read.party_private', 'read.owner_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept',
  'commit_order', 'manage_participants', 'transfer_ownership', 'lead', 'export', 'staff.case_read',
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const SideSchema = z.enum(['owner', 'buyer', 'seller', 'participant', 'staff']);
export type Side = z.infer<typeof SideSchema>;
export const ResourceKindSchema = z.enum(['project', 'rfq', 'quote', 'agreement', 'order', 'thread', 'publication']);
export const ResourceRefSchema = z.strictObject({ kind: ResourceKindSchema, id: IdSchema });
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/**
 * One row joins a resource to a party with capabilities, side, highest audience and validity; derived rows are materialised.
 * A `staff.case_read` row does not use `audience`: its projection layer is always `staff_case` and its field set is derived
 * from the `CaseAccessGrant` referenced by `caseRef` (projection class and excluded field classes), never from this row.
 */
export const ObjectParticipationSchema = z.strictObject({
  id: IdSchema,
  resource: ResourceRefSchema,
  party: PartySchema,
  side: SideSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  audience: GrantAudienceSchema,
  validFrom: TimestampSchema,
  validUntil: TimestampSchema.nullable(),
  grantedBy: z.strictObject({ personId: IdSchema, onBehalfOf: PartySchema.nullable() }),
  revokedAt: TimestampSchema.nullable(),
  revokedReason: ShortTextSchema.nullable(),
  revision: RevisionSchema,
  caseRef: IdSchema.nullable(),
})
  .refine((p) => !p.capabilities.includes('read.public'), { message: 'read.public is implicit and never stored', path: ['capabilities'] })
  .refine((p) => !p.capabilities.includes('staff.case_read') || (p.caseRef !== null && p.side === 'staff'), { message: 'staff.case_read requires a case reference and staff side', path: ['caseRef'] });
export type ObjectParticipation = z.infer<typeof ObjectParticipationSchema>;

export function participationActive(p: ObjectParticipation, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && p.revokedAt === null && Date.parse(p.validFrom) <= t && (p.validUntil === null || Date.parse(p.validUntil) > t);
}
/** No amplification: a grantor may grant only capabilities and audience they currently hold. */
export function canGrant(grantor: { capabilities: readonly Capability[]; audience: z.infer<typeof GrantAudienceSchema> }, requested: { capabilities: readonly Capability[]; audience: z.infer<typeof GrantAudienceSchema> }): boolean {
  const rank = { shared_party: 1, party_private: 2, owner_private: 3 } as const;
  if (!grantor.capabilities.includes('manage_participants')) return false;
  if (requested.capabilities.some((c) => c.startsWith('staff.'))) return false;
  return requested.capabilities.every((c) => grantor.capabilities.includes(c)) && rank[requested.audience] <= rank[grantor.audience];
}

/** Resolved on every request from the session; never cached across requests without the epoch. */
export const PrincipalSchema = z.strictObject({
  personId: IdSchema,
  emailVerified: z.boolean(),
  authenticatedAt: TimestampSchema,
  authzEpoch: z.int().min(0),
  membership: z.strictObject({
    companyId: IdSchema,
    membershipId: IdSchema,
    role: z.enum(['member', 'administrator']),
    permissions: z.array(CompanyPermissionSchema),
    companyAuthzEpoch: z.int().min(0),
  }).nullable(),
  /**
   * Active staff roles from `staff_role_assignment` that cover this deployment (platform, this node, or this hub).
   * The console vocabulary: the platform roles plus the hub roles of `HUB_STAFF_ROLES` in hub.ts (listed here because
   * hub.ts imports this file); tests/contracts/staff-roles.test.ts keeps both lists equal.
   */
  staff: z.array(z.enum([...STAFF_ROLES, 'hub-owner', 'compliance-officer', 'node-operator'])),
  delegation: z.strictObject({ mandateId: IdSchema, mandateRevision: RevisionSchema, principalPersonId: IdSchema }).nullable(),
});
export type Principal = z.infer<typeof PrincipalSchema>;

export const DenyReasonSchema = z.enum([
  'no_participation', 'capability_missing', 'membership_permission_missing', 'participation_expired', 'participation_revoked', 'membership_ended',
  'mandate_revoked', 'mandate_scope', 'email_unverified', 'step_up_required', 'lifecycle', 'staff_no_case',
]);
export const DecisionBasisSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner') }),
  z.strictObject({ kind: z.literal('participation'), id: IdSchema, revision: RevisionSchema }),
  z.strictObject({ kind: z.literal('membership'), id: IdSchema, permission: CompanyPermissionSchema }),
  z.strictObject({ kind: z.literal('mandate'), id: IdSchema, revision: RevisionSchema }),
  z.strictObject({ kind: z.literal('staff_case'), caseRef: IdSchema }),
  z.strictObject({ kind: z.literal('public_projection') }),
]);
export const PolicyInputSchema = z.strictObject({
  principal: PrincipalSchema.nullable(),
  action: CapabilitySchema,
  resource: z.strictObject({ kind: ResourceKindSchema, id: IdSchema, ownerParty: PartySchema, lifecycle: z.string().min(1).max(40), publishedProjection: z.boolean() }),
  context: z.strictObject({ mandateId: IdSchema.optional(), expectedRevision: RevisionSchema.optional(), budgetIds: z.array(IdSchema).optional() }).optional(),
});
export type PolicyInput = z.infer<typeof PolicyInputSchema>;
export const PolicyDecisionSchema = z.discriminatedUnion('effect', [
  z.strictObject({ effect: z.literal('allow'), projection: ProjectionLayerSchema, side: SideSchema.nullable(), basis: z.array(DecisionBasisSchema).min(1), authzEpoch: z.int().min(0), evaluatedAt: TimestampSchema }),
  z.strictObject({ effect: z.literal('deny'), reason: DenyReasonSchema, authzEpoch: z.int().min(0), evaluatedAt: TimestampSchema, disclose: z.enum(['not_found', 'forbidden', 'step_up']) }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** Cache key for a decision; a hit with an older epoch is a miss (see access policy section 5). */
export const PolicyCacheKeySchema = z.strictObject({
  personId: IdSchema,
  personEpoch: z.int().min(0),
  companyEpoch: z.int().min(0).nullable(),
  resourceKind: ResourceKindSchema,
  resourceId: IdSchema,
  resourceRevision: RevisionSchema,
  projection: ProjectionLayerSchema,
});
