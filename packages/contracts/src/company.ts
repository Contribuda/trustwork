import { z } from 'zod';
import { IdSchema, NameSchema, RevisionSchema, ShortTextSchema, TextSchema, TimestampSchema } from './common/ids.js';
import { pickFields } from './common/projection.js';
import { EmailSchema } from './identity.js';

/** Company-scoped permissions a membership may carry; informational context on the principal, never an object shortcut (R28). */
export const COMPANY_PERMISSIONS = ['company.page.edit', 'company.publish', 'company.members.manage', 'company.deals.manage', 'company.catalogue.edit', 'company.billing.view', 'company.billing.manage'] as const;
export const CompanyPermissionSchema = z.enum(COMPANY_PERMISSIONS);
export type CompanyPermission = z.infer<typeof CompanyPermissionSchema>;

/** sourced -> claimed -> verified are distinct labels; a legal identifier is not verification. */
export const CompanyStatusSchema = z.enum(['sourced', 'claimed', 'verified']);
export const LegalIdentifierSchema = z.strictObject({ kind: z.string().regex(/^(?:[A-Z]{2}-[A-Z]{2,8}|other)$/), value: z.string().min(1).max(64), status: z.enum(['sourced', 'claimed', 'verified']) });

export const CompanySchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  status: CompanyStatusSchema,
  legalIdentifiers: z.array(LegalIdentifierSchema),
  publicDescription: TextSchema.nullable(),
  verifiedDomains: z.array(z.string().min(1).max(253)),
  /** owner_private: visible to administrators only. */
  membershipRequests: z.array(z.strictObject({ personId: IdSchema, requestedAt: TimestampSchema })),
  billingAccountId: IdSchema.nullable(),
  internalNotes: TextSchema.nullable(),
  revision: RevisionSchema,
  createdAt: TimestampSchema,
});
export type Company = z.infer<typeof CompanySchema>;

export const PublicCompanySchema = z.strictObject({
  id: IdSchema,
  name: NameSchema,
  status: CompanyStatusSchema,
  legalIdentifiers: z.array(LegalIdentifierSchema),
  publicDescription: TextSchema.nullable(),
});
export type PublicCompany = z.infer<typeof PublicCompanySchema>;
export function toPublicCompany(company: Company): PublicCompany {
  return PublicCompanySchema.parse(pickFields(company, ['id', 'name', 'status', 'legalIdentifiers', 'publicDescription']));
}

export const MembershipStatusSchema = z.enum(['invited', 'active', 'declined', 'expired', 'withdrawn', 'ended']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;
export const MembershipRoleSchema = z.enum(['member', 'administrator']);

export const MembershipSchema = z
  .strictObject({
    id: IdSchema,
    personId: IdSchema,
    companyId: IdSchema,
    role: MembershipRoleSchema,
    permissions: z.array(CompanyPermissionSchema),
    status: MembershipStatusSchema,
    invitedBy: IdSchema.nullable(),
    invitedAt: TimestampSchema,
    validFrom: TimestampSchema.nullable(),
    endedAt: TimestampSchema.nullable(),
    endedBy: IdSchema.nullable(),
    endedReason: ShortTextSchema.nullable(),
    revision: RevisionSchema,
  })
  .refine((m) => (m.status === 'active') === (m.validFrom !== null && m.endedAt === null), { message: 'active iff validFrom set and not ended', path: ['status'] })
  .refine((m) => (m.status === 'ended') === (m.endedAt !== null), { message: 'ended iff endedAt set', path: ['endedAt'] })
  .refine((m) => m.status !== 'ended' || (m.endedBy !== null && m.endedReason !== null), { message: 'ended memberships record actor and reason', path: ['endedBy'] });
export type Membership = z.infer<typeof MembershipSchema>;

const MEMBERSHIP_TRANSITIONS: Record<MembershipStatus, readonly MembershipStatus[]> = {
  invited: ['active', 'declined', 'expired', 'withdrawn'],
  active: ['active', 'ended'],
  declined: [],
  expired: [],
  withdrawn: [],
  ended: [],
};
export function membershipTransitionAllowed(from: MembershipStatus, to: MembershipStatus): boolean {
  return MEMBERSHIP_TRANSITIONS[from].includes(to);
}
/** One active ordinary employer: accepting while another membership is active is `membership.already_employed`. */
export function canActivateMembership(candidate: Membership, personMemberships: readonly Membership[]): 'ok' | 'membership.already_employed' | 'membership.invitation_expired' {
  if (candidate.status !== 'invited') return 'membership.invitation_expired';
  const other = personMemberships.some((m) => m.id !== candidate.id && m.personId === candidate.personId && m.status === 'active');
  return other ? 'membership.already_employed' : 'ok';
}
/** The last administrator of a company cannot be demoted or ended. */
export function wouldRemoveLastAdministrator(target: Membership, companyMemberships: readonly Membership[]): boolean {
  if (target.role !== 'administrator' || target.status !== 'active') return false;
  return !companyMemberships.some((m) => m.id !== target.id && m.companyId === target.companyId && m.status === 'active' && m.role === 'administrator');
}

export const InviteMemberCommandSchema = z.strictObject({ companyId: IdSchema, inviteeEmail: EmailSchema, role: MembershipRoleSchema, permissions: z.array(CompanyPermissionSchema) });
export const AcceptMembershipCommandSchema = z.strictObject({ membershipId: IdSchema, invitationToken: z.string().min(16).max(256) });
export const ChangeMembershipCommandSchema = z.strictObject({ membershipId: IdSchema, role: MembershipRoleSchema, permissions: z.array(CompanyPermissionSchema), expectedRevision: RevisionSchema });
export const EndMembershipCommandSchema = z.strictObject({ membershipId: IdSchema, reason: ShortTextSchema, expectedRevision: RevisionSchema });
