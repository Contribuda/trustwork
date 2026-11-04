import type { ClaimDisputeRow, ClaimRecipe, ClaimsSettingsRow, CompanyClaimRow, CompanyHandoverRow, CompanyVerificationRow, PublicBadge } from './deps.js';

/**
 * Response projections of the claim routes: camelCase, timestamps as ISO strings. A claimant sees their own claim and
 * its state, never who reviewed it, the reviewer's note, a dispute's id or anything about another claimant. Staff of
 * the hub see the whole record; evidence stays in the verification checks, by reference.
 */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export const toOwnClaim = (r: CompanyClaimRow) => ({
  id: r.id, hubId: r.hub_id, companyId: r.company_id, level: r.level, recipeId: r.recipe_id, domainTie: r.domain_tie, state: r.state, waitingUntil: iso(r.waiting_until), decidedAt: iso(r.decided_at),
  revision: r.revision, createdAt: iso(r.created_at),
});
export const toOwnHandover = (r: CompanyHandoverRow) => ({
  id: r.id, hubId: r.hub_id, companyId: r.company_id, level: r.level, coolingUntil: iso(r.cooling_until), createdAt: iso(r.created_at), revokedAt: iso(r.revoked_at),
});
export const toRecipe = (r: ClaimRecipe) => ({ id: r.id, level: r.level, key: r.key, version: r.version, steps: r.steps, badgeCategories: r.badge_categories, recheckMonths: r.recheck_months });

export const toClaim = (r: CompanyClaimRow) => ({
  ...toOwnClaim(r), claimantId: r.claimant_id, domainTieDomain: r.domain_tie_domain, disputeId: r.dispute_id, decidedBy: r.decided_by, decisionNote: r.decision_note,
});
export const toDispute = (r: ClaimDisputeRow) => ({
  id: r.id, hubId: r.hub_id, companyId: r.company_id, state: r.state, proposedClaimId: r.proposed_claim_id, proposedNone: r.proposed_none, proposedBy: r.proposed_by, proposedNote: r.proposed_note,
  confirmedBy: r.confirmed_by, decidedAt: iso(r.decided_at), revision: r.revision, createdAt: iso(r.created_at),
});
export const toHandover = (r: CompanyHandoverRow) => ({
  ...toOwnHandover(r), claimId: r.claim_id, personId: r.person_id, membershipId: r.membership_id, decidedBy: r.decided_by, revokedBy: r.revoked_by, revokeReason: r.revoke_reason,
});
/** A holder's own verification, read through the console: as for a claim, not who decided it. */
export const toOwnVerification = (r: CompanyVerificationRow) => ({
  id: r.id, hubId: r.hub_id, companyId: r.company_id, handoverId: r.handover_id, level: r.level, recipeId: r.recipe_id, categories: r.categories, state: r.state, decidedAt: iso(r.decided_at),
  validUntil: iso(r.valid_until), renewedFrom: r.renewed_from, revokedAt: iso(r.revoked_at), revocationReasonCode: r.revocation_reason_code,
});
export const toVerification = (r: CompanyVerificationRow) => ({ ...toOwnVerification(r), decidedBy: r.decided_by });
/** The whole public projection of a badge: level, categories and dates. */
export const toBadge = (r: PublicBadge) => ({ level: r.level, categories: r.categories, decidedAt: iso(r.decided_at), validUntil: iso(r.valid_until) });
export const toSettings = (hubId: string, r: ClaimsSettingsRow | undefined) => ({
  hubId, waitingDays: r?.waiting_days ?? 7, coolingDays: r?.cooling_days ?? 7, revision: r?.revision ?? 0, updatedAt: iso(r?.updated_at ?? null),
});
