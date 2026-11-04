import { ApiError } from '../../common/errors.js';
import { mapDealError } from '../sales/common.js';

type Code = ConstructorParameters<typeof ApiError>[0];
const HINTS: Record<string, { code: Code; reason: string }> = {
  'sourcing.not_found': { code: 'access.not_found', reason: 'not_found' },
  'sourcing.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'sourcing.sealed': { code: 'access.forbidden', reason: 'sealed_until_deadline' },
  'sourcing.revision_conflict': { code: 'validation.revision_conflict', reason: 'revision_conflict' },
  'sourcing.draft_exists': { code: 'validation.revision_conflict', reason: 'draft_exists' },
  'sourcing.digest_mismatch': { code: 'validation.revision_conflict', reason: 'digest_mismatch' },
  'sourcing.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'sourcing.frozen': { code: 'commercial.version_immutable', reason: 'frozen' },
  'sourcing.pin_mismatch': { code: 'commercial.digest_mismatch', reason: 'pin_mismatch' },
  'sourcing.stale_comparable': { code: 'commercial.stale_version', reason: 'stale_comparable' },
  'sourcing.captured_quote_unavailable': { code: 'validation.schema', reason: 'captured_quote_unavailable' },
};

/** Database refusals of the sourcing commands as contract codes; `details.reason` names the rule. Deal hints fall through. */
export function sourcingRefusal(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  if (pg && typeof pg.code === 'string' && !(error instanceof ApiError)) {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason: 'revision_conflict' });
  }
  return mapDealError(error);
}
