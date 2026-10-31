import { ApiError } from '../../common/errors.js';

type Code = ConstructorParameters<typeof ApiError>[0];
const HINTS: Record<string, { code: Code; reason: string }> = {
  'approvals.not_found': { code: 'access.not_found', reason: 'not_found' },
  'approvals.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'approvals.requester_cannot_decide': { code: 'access.forbidden', reason: 'requester_cannot_decide' },
  'approvals.not_an_approver': { code: 'access.forbidden', reason: 'not_an_approver' },
  'approvals.delegation_exceeds_rights': { code: 'access.forbidden', reason: 'delegation_exceeds_rights' },
  'approvals.first_party_required': { code: 'access.forbidden', reason: 'first_party_required' },
  'approvals.sod_violation': { code: 'access.second_approver_required', reason: 'sod_violation' },
  'approvals.second_person_required': { code: 'access.second_approver_required', reason: 'second_person_required' },
  'approvals.step_up_required': { code: 'auth.step_up_required', reason: 'step_up_required' },
  'approvals.digest_mismatch': { code: 'access.approval_digest_mismatch', reason: 'digest_mismatch' },
  'approvals.revision_conflict': { code: 'validation.revision_conflict', reason: 'revision_conflict' },
  'approvals.not_pending': { code: 'validation.revision_conflict', reason: 'not_pending' },
  'approvals.step_not_pending': { code: 'validation.revision_conflict', reason: 'step_not_pending' },
  'approvals.already_decided': { code: 'validation.revision_conflict', reason: 'already_decided' },
  'approvals.already_pending': { code: 'validation.revision_conflict', reason: 'already_pending' },
  'approvals.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'approvals.no_active_route': { code: 'validation.schema', reason: 'no_active_route' },
  'approvals.no_applicable_step': { code: 'validation.schema', reason: 'no_applicable_step' },
  'approvals.no_eligible_approver': { code: 'validation.schema', reason: 'no_eligible_approver' },
  'approvals.unknown_step': { code: 'validation.schema', reason: 'unknown_step' },
  'approvals.project_mismatch': { code: 'validation.schema', reason: 'project_mismatch' },
  'approvals.invalid_delegate': { code: 'validation.schema', reason: 'invalid_delegate' },
  'approvals.invalid_delegation': { code: 'validation.schema', reason: 'invalid_delegation' },
  'approvals.reason_required': { code: 'validation.schema', reason: 'reason_required' },
  'approvals.invalid_decision': { code: 'validation.schema', reason: 'invalid_decision' },
  'approvals.route_frozen': { code: 'commercial.version_immutable', reason: 'route_frozen' },
  'approvals.request_frozen': { code: 'commercial.version_immutable', reason: 'request_frozen' },
  'approvals.delegation_frozen': { code: 'commercial.version_immutable', reason: 'delegation_frozen' },
  'approvals.record_permanent': { code: 'commercial.version_immutable', reason: 'record_permanent' },
};

/** Database refusals of the approval commands as contract codes; `details.reason` names the rule, `details.rule` a broken SoD rule. */
export function approvalRefusal(error: unknown): never {
  const pg = error as { code?: string; hint?: string; detail?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason, ...(pg.hint === 'approvals.sod_violation' && pg.detail ? { rule: pg.detail } : {}) });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { constraint: pg.constraint ?? null });
    if (pg.code === '42501') throw new ApiError('access.forbidden', 'not allowed', { reason: 'row_security' });
  }
  throw error;
}
