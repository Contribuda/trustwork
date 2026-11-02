import type { VerificationCheckRow, VerificationProviderRow, VerificationRecipeRow } from './deps.js';

/**
 * Response projections of the verification routes: camelCase, timestamps as ISO strings. A check names its evidence
 * reference and, for the sanctions check, the SANC-003 state it read; never a document and never a match.
 */
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export const toProvider = (r: VerificationProviderRow) => ({
  id: r.id, hubId: r.hub_id, checkType: r.check_type, adapter: r.adapter, mode: r.mode, credentialRefId: r.credential_ref_id, approvalId: r.approval_id, retentionDays: r.retention_days,
  legalBasis: r.legal_basis, costMinor: r.cost_minor === null ? null : String(r.cost_minor), status: r.status, revision: r.revision, createdBy: r.created_by, createdAt: iso(r.created_at),
});
export const toRecipe = (r: VerificationRecipeRow) => ({
  id: r.id, hubId: r.hub_id, key: r.key, version: r.version, subjectKind: r.subject_kind, trigger: r.trigger, steps: r.steps, badgeCategories: r.badge_categories,
  recheckMonths: r.recheck_months, status: r.status, draftedBy: r.drafted_by, activatedBy: r.activated_by, activatedAt: iso(r.activated_at), revision: r.revision, createdAt: iso(r.created_at),
});
export const toCheck = (r: VerificationCheckRow) => ({
  id: r.id, hubId: r.hub_id, subject: r.subject_person_id ? { kind: 'person' as const, id: r.subject_person_id } : { kind: 'company' as const, id: r.subject_company_id as string },
  recipeId: r.recipe_id, checkType: r.check_type, providerId: r.provider_id, mode: r.mode, result: r.result, evidenceRef: r.evidence_ref, screeningStateId: r.screening_state_id,
  recordedBy: r.recorded_by, recordedAt: iso(r.recorded_at), expiresAt: iso(r.expires_at),
});
