import { ApiError } from '../../common/errors.js';

interface PgError { code?: string; hint?: string }

/** Database refusals of the screening commands as contract codes; existence never leaks to someone who may not read it. */
export function screeningRefusal(error: unknown): never {
  const hint = (error as PgError)?.hint;
  switch (hint) {
    case 'screening.match_not_found':
    case 'screening.subject_not_found':
    case 'access.not_found':
      throw new ApiError('access.not_found');
    case 'screening.self_decision':
    case 'screening.subject_member':
    case 'screening.same_reviewer':
    case 'screening.not_subject':
    case 'admin.conflict_of_interest':
    case 'admin.forbidden':
    case 'admin.elevation_required':
      throw new ApiError('access.forbidden', 'only a compliance officer of this node who is not the subject, not a member of the subject company and not conflicted decides', { reason: hint });
    case 'screening.second_person_required':
      throw new ApiError('access.second_approver_required', 'a second person other than the proposer decides', { reason: hint });
    case 'access.approval_digest_mismatch':
      throw new ApiError('access.approval_digest_mismatch', 'the reviewed digest differs from the proposal');
    case 'screening.match_state':
    case 'screening.routing_conflict':
    case 'screening.nothing_to_appeal':
    case 'admin.approval_not_pending':
    case 'admin.approval_expired':
      throw new ApiError('validation.revision_conflict', 'the match is no longer in a state this decision applies to', { reason: hint });
    case 'screening.reason_required':
    case 'screening.evidence_required':
    case 'screening.invalid_decision':
      throw new ApiError('validation.schema', 'a reason and an evidence category are required', { reason: hint });
    default:
      throw error;
  }
}
