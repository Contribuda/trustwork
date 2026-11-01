import type { ErrorCode } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';

/**
 * Refusals of the HUB-001 and DATA-002 commands (SQLSTATE plus a hint) as contract error codes. The hint travels in
 * `details.reason` (an English machine code) and the refused items (gates, places, keys) in `details.items`, so the
 * console explains the refusal from its locale files. Existence never leaks: `admin.not_found` is `access.not_found`.
 * This module never imports platform-admin (tested), so the administration hints it meets are listed here too.
 */
const HINTS: Readonly<Record<string, ErrorCode>> = {
  'admin.not_found': 'access.not_found',
  'admin.forbidden': 'access.forbidden',
  'admin.elevation_required': 'access.forbidden',
  'access.no_principal': 'access.forbidden',
  'admin.self_approval': 'access.second_approver_required',
  'admin.approval_required': 'access.approval_required',
  'admin.approval_expired': 'access.approval_required',
  'admin.approval_consumed': 'access.approval_required',
  'admin.approval_not_approved': 'access.approval_required',
  'admin.not_requester': 'access.approval_required',
  'admin.approval_mismatch': 'access.approval_digest_mismatch',
  'admin.context_invalid': 'validation.schema',
  'admin.immutable': 'validation.schema',
  'validation.not_canonicalizable': 'validation.not_canonicalizable',
  'kernel.restricted_place': 'validation.schema',
  'kernel.jurisdiction_unknown': 'validation.schema',
  'kernel.jurisdiction_not_selectable': 'validation.schema',
  'kernel.pack_unknown': 'validation.schema',
  'hubs.restricted_place': 'validation.schema',
  'hubs.restricted_place_removed': 'validation.schema',
  'hubs.added_place_invalid': 'validation.schema',
  'hubs.territory_restricted': 'validation.schema',
  'hubs.territory_invalid': 'validation.schema',
  'hubs.territory_required': 'validation.schema',
  'hubs.territory_limit': 'validation.schema',
  'hubs.territory_exists': 'validation.revision_conflict',
  'hubs.access_widening': 'validation.schema',
  'hubs.attestation_contradicted': 'validation.schema',
  'hubs.retention_invalid': 'validation.schema',
  'hubs.payload_invalid': 'validation.schema',
  'hubs.domain_unknown': 'validation.schema',
  'hubs.time_zone_unknown': 'validation.schema',
  'hubs.locale_not_in_hub': 'validation.schema',
  'hubs.gate_unknown': 'validation.schema',
  'hubs.gate_evidence_required': 'validation.schema',
  'hubs.gate_precondition': 'validation.schema',
  'hubs.counsel_approval_required': 'validation.schema',
  'hubs.counsel_date': 'validation.schema',
  'hubs.counsel_documents': 'validation.schema',
  'hubs.launch_gate_open': 'validation.schema',
  'hubs.transition_not_allowed': 'validation.revision_conflict',
  'hubs.invalid_transition': 'validation.revision_conflict',
  'hubs.revision_conflict': 'validation.revision_conflict',
  'hubs.config_stale': 'validation.revision_conflict',
  'hubs.version_immutable': 'validation.schema',
  'hubs.hub_closed': 'validation.revision_conflict',
  'hubs.no_node': 'validation.schema',
  // AGT-003: the activation hook of the `agents` domain (a version the agent module registry did not validate, or a stale preview).
  'agents.policy_unvalidated': 'validation.schema',
  'agents.preview_stale': 'validation.revision_conflict',
};

interface PgError { code?: string; hint?: string; detail?: string; constraint?: string }

/** The contract error for a database refusal, or null when the error is not one of these refusals. */
export function hubsRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  if (!pg || typeof pg.code !== 'string') return null;
  if (pg.code === '23503') return new ApiError('validation.schema', 'validation.schema', { reason: 'unknown_reference' });
  if (pg.code === '23505' && !pg.hint) return new ApiError('validation.revision_conflict', 'validation.revision_conflict', { reason: pg.constraint === 'hub_slug_key' ? 'slug_taken' : 'duplicate' });
  if (pg.code === '23514' && !pg.hint) return new ApiError('validation.schema', 'validation.schema', { reason: 'constraint', constraint: pg.constraint ?? null });
  if (typeof pg.hint !== 'string') return null;
  const code = HINTS[pg.hint];
  if (!code) return null;
  const reason = pg.hint.replace(/^(admin|access|validation|hubs|kernel|agents)\./, '');
  const items = pg.detail ? pg.detail.split(',').filter(Boolean) : undefined;
  return new ApiError(code, code, { reason, ...(items ? { items } : {}), ...(pg.hint === 'admin.elevation_required' ? { required: 'elevation' } : pg.hint === 'admin.forbidden' ? { required: 'permission' } : {}) });
}

/** Refusals of authority that are recorded as `denied` audit rows (not shape errors or missing objects). */
export function isAuthorityRefusal(refusal: ApiError): boolean {
  return ['access.forbidden', 'access.second_approver_required', 'access.approval_required', 'access.approval_digest_mismatch'].includes(refusal.code);
}
