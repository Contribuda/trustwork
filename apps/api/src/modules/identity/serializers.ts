import {
  CompanySchema,
  MembershipSchema,
  ObjectParticipationSchema,
  PersonSchema,
  PublicPersonSchema,
  SessionSchema,
  type Capability,
  type Company,
  type CompanyPermission,
  type Membership,
  type ObjectParticipation,
  type Person,
  type PublicPerson,
  type Session,
} from '../../deps/contracts.js';
import type * as db from '../../deps/data.js';
type PublicPersonRow = db.auth.PublicPersonRow;

/** Database rows -> frozen contract records. Every serializer re-validates through the strict schema. */
export const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export function toPerson(row: db.Person, bindings: readonly db.EmailBinding[], credentials: readonly Omit<db.Credential, 'password_hash'>[]): Person {
  return PersonSchema.parse({
    id: row.id,
    displayName: row.display_name,
    profileVisibility: row.profile_visibility,
    publicProfile: { headline: row.public_headline, expertise: row.public_expertise },
    emailBindings: bindings.map((b) => ({ email: b.email_normalized, verifiedAt: b.verified_at ? iso(b.verified_at) : null, isPrimary: b.is_primary })),
    providerIdentities: credentials.filter((c) => c.provider && c.provider_subject && !c.disabled_at).map((c) => ({ provider: c.provider as 'google' | 'apple', subject: c.provider_subject as string })),
    preferences: { buying: row.prefers_buying, selling: row.prefers_selling, industryParticipation: row.prefers_industry_participation },
    revision: row.revision,
    createdAt: iso(row.created_at),
  });
}

export function publicPersonFromRow(row: PublicPersonRow): PublicPerson {
  return PublicPersonSchema.parse({ id: row.id, displayName: row.display_name, publicProfile: { headline: row.public_headline, expertise: row.public_expertise } });
}

export function toSession(row: db.Session): Session {
  return SessionSchema.parse({
    id: row.id,
    personId: row.person_id,
    tokenHash: row.token_hash.toString('hex'),
    createdAt: iso(row.created_at),
    lastSeenAt: iso(row.last_seen_at),
    idleExpiresAt: iso(row.idle_expires_at),
    absoluteExpiresAt: iso(row.absolute_expires_at),
    authenticatedAt: iso(row.authenticated_at),
    authMethod: row.auth_method,
    client: { userAgentFamily: row.user_agent_family, ipPrefix: row.ip_prefix },
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    revokedReason: row.revoked_reason,
  });
}

export function toMembership(row: db.Membership): Membership {
  return MembershipSchema.parse({
    id: row.id,
    personId: row.person_id,
    companyId: row.company_id,
    role: row.role,
    permissions: row.permissions as CompanyPermission[],
    status: row.status,
    invitedBy: row.invited_by,
    invitedAt: iso(row.invited_at),
    validFrom: row.valid_from ? iso(row.valid_from) : null,
    endedAt: row.ended_at ? iso(row.ended_at) : null,
    endedBy: row.ended_by,
    endedReason: row.ended_reason,
    revision: row.revision,
  });
}

export function toCompany(row: db.Company, priv: db.CompanyPrivate | null): Company {
  return CompanySchema.parse({
    id: row.id,
    name: row.display_name,
    status: row.claim_status === 'unclaimed' ? 'sourced' : row.claim_status,
    legalIdentifiers: row.legal_identifiers,
    publicDescription: row.public_description,
    verifiedDomains: row.verified_domains,
    membershipRequests: [],
    billingAccountId: priv?.billing_account_id ?? null,
    internalNotes: priv?.internal_notes ?? null,
    revision: row.revision,
    createdAt: iso(row.created_at),
  });
}

export function toParticipation(row: db.ObjectParticipation): ObjectParticipation {
  return ObjectParticipationSchema.parse({
    id: row.id,
    resource: { kind: row.resource_kind, id: row.resource_id },
    party: row.party_person_id ? { kind: 'person', id: row.party_person_id } : { kind: 'company', id: row.party_company_id as string },
    side: row.side,
    capabilities: row.capabilities as Capability[],
    audience: row.audience,
    validFrom: iso(row.valid_from),
    validUntil: row.valid_until ? iso(row.valid_until) : null,
    grantedBy: {
      personId: row.granted_by_person_id,
      onBehalfOf: row.on_behalf_of_person_id ? { kind: 'person', id: row.on_behalf_of_person_id } : row.on_behalf_of_company_id ? { kind: 'company', id: row.on_behalf_of_company_id } : null,
    },
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    revokedReason: row.revoked_reason,
    revision: row.revision,
    caseRef: row.case_ref,
  });
}
