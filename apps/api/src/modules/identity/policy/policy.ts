import type { z } from 'zod';
import {
  canGrant,
  DenyReasonSchema,
  participationActive,
  PolicyDecisionSchema,
  type Capability,
  type CompanyPermission,
  type GrantAudience,
  type ObjectParticipation,
  type Party,
  type PolicyDecision,
  type PolicyInput,
  type Principal,
  type ProjectionLayer,
} from '../../../deps/contracts.js';

/**
 * In-process object policy (ADR 002 / access policy section 4). Pure: the caller loads the live participation rows
 * visible to the principal's parties. Deny by default; evaluation order public-projection -> owner -> participation
 * (company parties need the membership permission) -> mandate cap -> staff case. The decision is valid only for the
 * request that computed it; caches key it with `PolicyCacheKey` (epochs + resource revision).
 */
export type PolicyResource = PolicyInput['resource'];

/** Owner rows carry every non-staff capability; materialised at creation and on ownership transfer. */
export const OWNER_CAPABILITIES: readonly Capability[] = [
  'read.shared', 'read.party_private', 'read.owner_private', 'write.draft', 'publish', 'invite', 'negotiate', 'accept', 'commit_order', 'manage_participants', 'transfer_ownership', 'lead', 'export',
];
export const LEADER_CAPABILITIES: readonly Capability[] = ['read.shared', 'lead'];

/** Actions that require a verified primary e-mail even with a valid session (auth ADR section 4). */
const VERIFIED_EMAIL_ACTIONS: ReadonlySet<Capability> = new Set(['publish', 'invite', 'manage_participants', 'transfer_ownership', 'negotiate', 'accept', 'commit_order']);

/**
 * A company party is exercised by members holding the matching membership permission (R28): `company.publish` for
 * publishing, `company.deals.manage` for everything else. Reads of a company-owned object need the same permission:
 * "member of the company" alone never reaches private data (acceptance case "own-company member without grant").
 * Publishing an RFQ version to its invited suppliers is deal work and needs only `company.deals.manage` (integrator
 * decision after COM-001, applied in COM-002); its public projection still needs `company.publish` (checked by the
 * procurement module and `trustwork.rfq_can(..., 'publish_projection')`).
 */
export function companyPermissionFor(action: Capability, resourceKind?: PolicyResource['kind']): CompanyPermission {
  if (action === 'publish' && resourceKind === 'rfq') return 'company.deals.manage';
  return action === 'publish' ? 'company.publish' : 'company.deals.manage';
}

const AUDIENCE_LAYER: Record<GrantAudience, ProjectionLayer> = { shared_party: 'shared_party', party_private: 'party_private', owner_private: 'owner_private' };

export interface EvaluationInput {
  principal: Principal | null;
  action: Capability;
  resource: PolicyResource;
  /** Live and historical rows of the principal's own parties on the resource (RLS already scopes them). */
  participations: readonly ObjectParticipation[];
  now: Date;
}

type DenyReason = z.infer<typeof DenyReasonSchema>;
function deny(reason: DenyReason, disclose: 'not_found' | 'forbidden' | 'step_up', epoch: number, now: Date): PolicyDecision {
  return PolicyDecisionSchema.parse({ effect: 'deny', reason, disclose, authzEpoch: epoch, evaluatedAt: now.toISOString() });
}
function partyMatches(party: Party, principal: Principal): 'person' | 'company' | null {
  if (party.kind === 'person' && party.id === principal.personId) return 'person';
  if (party.kind === 'company' && principal.membership && party.id === principal.membership.companyId) return 'company';
  return null;
}

export function evaluatePolicy(input: EvaluationInput): PolicyDecision {
  const { principal, action, resource, now } = input;
  const epoch = principal?.authzEpoch ?? 0;
  const at = now.toISOString();
  if (action === 'read.public') {
    return resource.publishedProjection
      ? PolicyDecisionSchema.parse({ effect: 'allow', projection: 'public', side: null, basis: [{ kind: 'public_projection' }], authzEpoch: epoch, evaluatedAt: at })
      : deny('no_participation', 'not_found', epoch, now);
  }
  if (!principal) return deny('no_participation', 'not_found', epoch, now);
  if (action.startsWith('staff.')) {
    const staffRow = input.participations.find((p) => p.side === 'staff' && p.caseRef !== null && participationActive(p, now) && p.capabilities.includes(action));
    if (principal.staff.length > 0 && staffRow) {
      return PolicyDecisionSchema.parse({ effect: 'allow', projection: 'staff_case', side: 'staff', basis: [{ kind: 'staff_case', caseRef: staffRow.caseRef }], authzEpoch: epoch, evaluatedAt: at });
    }
    return deny('staff_no_case', 'not_found', epoch, now);
  }
  if (principal.delegation) {
    // Mandates are not implemented in this slice: a delegated principal can never widen beyond "no authority".
    return deny('mandate_scope', 'forbidden', epoch, now);
  }
  if (VERIFIED_EMAIL_ACTIONS.has(action) && !principal.emailVerified) return deny('email_unverified', 'forbidden', epoch, now);

  const ownerVia = partyMatches(resource.ownerParty, principal);
  if (ownerVia === 'person') {
    return PolicyDecisionSchema.parse({ effect: 'allow', projection: 'owner_private', side: 'owner', basis: [{ kind: 'owner' }], authzEpoch: epoch, evaluatedAt: at });
  }
  if (ownerVia === 'company' && principal.membership) {
    const permission = companyPermissionFor(action, resource.kind);
    if (principal.membership.permissions.includes(permission)) {
      return PolicyDecisionSchema.parse({
        effect: 'allow', projection: 'owner_private', side: 'owner',
        basis: [{ kind: 'owner' }, { kind: 'membership', id: principal.membership.membershipId, permission }], authzEpoch: epoch, evaluatedAt: at,
      });
    }
    return deny('membership_permission_missing', resource.publishedProjection ? 'forbidden' : 'not_found', epoch, now);
  }

  let seen: 'expired' | 'revoked' | 'capability_missing' | 'permission_missing' | null = null;
  for (const row of input.participations) {
    if (row.side === 'staff') continue;
    const via = partyMatches(row.party, principal);
    if (!via) continue;
    if (row.revokedAt !== null) { seen ??= 'revoked'; continue; }
    if (!participationActive(row, now)) { seen = seen === 'revoked' ? seen : 'expired'; continue; }
    if (!row.capabilities.includes(action)) { seen ??= 'capability_missing'; continue; }
    if (via === 'company' && principal.membership) {
      const permission = companyPermissionFor(action, resource.kind);
      if (!principal.membership.permissions.includes(permission)) { seen ??= 'permission_missing'; continue; }
      return PolicyDecisionSchema.parse({
        effect: 'allow', projection: AUDIENCE_LAYER[row.audience], side: row.side,
        basis: [{ kind: 'participation', id: row.id, revision: row.revision }, { kind: 'membership', id: principal.membership.membershipId, permission }], authzEpoch: epoch, evaluatedAt: at,
      });
    }
    return PolicyDecisionSchema.parse({
      effect: 'allow', projection: AUDIENCE_LAYER[row.audience], side: row.side,
      basis: [{ kind: 'participation', id: row.id, revision: row.revision }], authzEpoch: epoch, evaluatedAt: at,
    });
  }
  if (seen === 'capability_missing') return deny('capability_missing', 'forbidden', epoch, now);
  if (seen === 'permission_missing') return deny('membership_permission_missing', resource.publishedProjection ? 'forbidden' : 'not_found', epoch, now);
  if (seen === 'expired') return deny('participation_expired', 'forbidden', epoch, now);
  if (seen === 'revoked') return deny('participation_revoked', 'not_found', epoch, now);
  if (principal.staff.length > 0) return deny('staff_no_case', 'not_found', epoch, now);
  return deny('no_participation', resource.publishedProjection ? 'forbidden' : 'not_found', epoch, now);
}

/** Highest projection the principal may read; `null` means the object is not found for them. */
export function readableProjection(input: Omit<EvaluationInput, 'action'>): { projection: ProjectionLayer; decision: PolicyDecision } | null {
  for (const action of ['read.owner_private', 'read.party_private', 'read.shared', 'read.public'] as const) {
    const decision = evaluatePolicy({ ...input, action });
    if (decision.effect === 'allow') return { projection: decision.projection, decision };
  }
  return null;
}

/** Effective grantor capabilities: union over the principal's live rows (company rows only with the permission). */
export function grantorCapabilities(principal: Principal, resource: PolicyResource, participations: readonly ObjectParticipation[], now: Date): { capabilities: Capability[]; audience: GrantAudience } {
  const capabilities = new Set<Capability>();
  let audience: GrantAudience = 'shared_party';
  const rank = { shared_party: 1, party_private: 2, owner_private: 3 } as const;
  const owner = partyMatches(resource.ownerParty, principal);
  if (owner === 'person' || (owner === 'company' && principal.membership?.permissions.includes('company.deals.manage'))) {
    for (const c of OWNER_CAPABILITIES) capabilities.add(c);
    audience = 'owner_private';
  }
  for (const row of participations) {
    if (row.side === 'staff' || !participationActive(row, now)) continue;
    const via = partyMatches(row.party, principal);
    if (!via) continue;
    if (via === 'company' && !principal.membership?.permissions.includes('company.deals.manage')) continue;
    for (const c of row.capabilities) capabilities.add(c);
    if (rank[row.audience] > rank[audience]) audience = row.audience;
  }
  return { capabilities: [...capabilities], audience };
}

/** No amplification (R10 / DATA-001 R3, R5, R6): the command layer refuses anything the grantor does not hold. */
export function grantAllowed(grantor: { capabilities: readonly Capability[]; audience: GrantAudience }, requested: { capabilities: readonly Capability[]; audience: GrantAudience }): boolean {
  return canGrant(grantor, requested);
}
