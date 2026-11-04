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
  'sourcing.company_buyer_required': { code: 'validation.schema', reason: 'company_buyer_required' },
  'sourcing.rfq_not_open': { code: 'validation.schema', reason: 'rfq_not_open' },
  'sourcing.rfq_not_closed': { code: 'validation.schema', reason: 'rfq_not_closed' },
  'sourcing.sheet_not_frozen': { code: 'validation.schema', reason: 'sheet_not_frozen' },
  'sourcing.sheet_superseded': { code: 'validation.revision_conflict', reason: 'sheet_superseded' },
  'sourcing.not_comparable': { code: 'commercial.stale_version', reason: 'not_comparable' },
  'sourcing.award_exists': { code: 'validation.revision_conflict', reason: 'award_exists' },
  'sourcing.award_required': { code: 'access.forbidden', reason: 'award_required' },
  'sourcing.award_not_approved': { code: 'access.forbidden', reason: 'award_not_approved' },
  'sourcing.award_not_executed': { code: 'validation.schema', reason: 'award_not_executed' },
  'sourcing.approval_digest_mismatch': { code: 'access.approval_digest_mismatch', reason: 'digest_mismatch' },
  'sourcing.execution_incomplete': { code: 'validation.schema', reason: 'execution_incomplete' },
  'sourcing.already_notified': { code: 'validation.revision_conflict', reason: 'already_notified' },
  'sourcing.feedback_needs_award': { code: 'validation.schema', reason: 'feedback_needs_award' },
  'approvals.first_party_required': { code: 'access.forbidden', reason: 'first_party_required' },
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
