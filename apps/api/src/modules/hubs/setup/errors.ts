import type { ErrorCode } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';
import { hubsRefusal } from '../errors.js';

/**
 * Refusals of the setup commands (SQLSTATE plus a `setup.*` hint) as contract error codes. The hint travels in
 * `details.reason` (an English machine code the wizard explains from its locale files) and the refused items (places,
 * missing steps, failed checks) in `details.items`. An unknown, expired or used token is `access.not_found`: the
 * wizard never says whether a token existed. HUB-001 and kernel refusals during finishing reuse the hubs mapping;
 * the attestation's own refusals are mapped here (SANC-009 hints).
 */
const HINTS: Readonly<Record<string, ErrorCode>> = {
  'setup.not_found': 'access.not_found',
  'setup.finished': 'access.not_found',
  'setup.owner_only': 'access.forbidden',
  'setup.first_admin_only': 'access.forbidden',
  'setup.admin_account_mismatch': 'access.forbidden',
  'setup.first_admin_bound': 'validation.revision_conflict',
  'setup.immutable': 'validation.revision_conflict',
  'setup.invalid_transition': 'validation.revision_conflict',
  'setup.step_out_of_order': 'validation.schema',
  'setup.step_invalid': 'validation.schema',
  'setup.answer_invalid': 'validation.schema',
  'setup.restricted_place': 'validation.schema',
  'setup.jurisdiction_unknown': 'validation.schema',
  'setup.jurisdiction_not_selectable': 'validation.schema',
  'setup.pack_unknown': 'validation.schema',
  'setup.node_fixed': 'validation.schema',
  'setup.install_check_failed': 'validation.schema',
  'setup.second_factor_required': 'validation.schema',
  'setup.second_factor_unavailable': 'validation.schema',
  'setup.attestation_required': 'validation.schema',
  'setup.hub_required': 'validation.schema',
  'setup.token_invalid': 'validation.schema',
  'attestation.restricted_place': 'validation.schema',
  'attestation.region_required': 'validation.schema',
  'attestation.stale': 'validation.revision_conflict',
  'attestation.restricted_list_unsynced': 'validation.schema',
  'attestation.no_node': 'validation.schema',
  'access.no_principal': 'access.forbidden',
};

interface PgError { code?: string; hint?: string; detail?: string }

export function setupRefusal(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  const pg = error as PgError | null;
  const hint = typeof pg?.hint === 'string' ? pg.hint : undefined;
  if (hint && Object.hasOwn(HINTS, hint)) {
    const code = HINTS[hint] as ErrorCode;
    const items = pg?.detail ? pg.detail.split(',').filter(Boolean) : undefined;
    return new ApiError(code, code, { reason: hint.replace(/^(setup|attestation|access)\./, ''), ...(items && code !== 'access.not_found' ? { items } : {}) });
  }
  return hubsRefusal(error);
}

/** Runs `fn` and rethrows a database refusal as its contract error. */
export async function mapRefusals<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw setupRefusal(error) ?? error;
  }
}

export const notFound = (): ApiError => new ApiError('access.not_found', 'access.not_found');
