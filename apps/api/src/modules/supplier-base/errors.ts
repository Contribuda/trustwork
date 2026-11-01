import { ApiError } from '../../common/errors.js';

type Code = ConstructorParameters<typeof ApiError>[0];
const HINTS: Record<string, { code: Code; reason: string }> = {
  'supplier_base.not_found': { code: 'access.not_found', reason: 'not_found' },
  'supplier_base.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'supplier_base.revision_conflict': { code: 'validation.revision_conflict', reason: 'revision_conflict' },
  'supplier_base.already_listed': { code: 'validation.revision_conflict', reason: 'already_listed' },
  'supplier_base.already_answered': { code: 'validation.revision_conflict', reason: 'already_answered' },
  'supplier_base.invalid_transition': { code: 'validation.revision_conflict', reason: 'invalid_transition' },
  'supplier_base.invalid_link': { code: 'validation.schema', reason: 'invalid_link' },
  'supplier_base.not_shareable': { code: 'validation.schema', reason: 'not_shareable' },
  'supplier_base.invalid_region': { code: 'validation.schema', reason: 'invalid_region' },
  'supplier_base.restricted_place': { code: 'validation.schema', reason: 'restricted_place' },
  'supplier_base.invalid_input': { code: 'validation.schema', reason: 'invalid_input' },
  'supplier_base.frozen': { code: 'commercial.version_immutable', reason: 'frozen' },
  'supplier_base.record_permanent': { code: 'commercial.version_immutable', reason: 'record_permanent' },
};

/** Database refusals of the supplier base commands as contract codes; `details.reason` names the rule. */
export function supplierBaseRefusal(error: unknown): never {
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string' && !(error instanceof ApiError)) {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    if (pg.code === '23505') {
      const reason = pg.constraint === 'external_counterparty_name_unique' ? 'name_taken' : 'already_listed';
      throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { reason });
    }
    if (pg.code === '23514' || pg.code === '22023' || pg.code === '22P02') throw new ApiError('validation.schema', 'the value does not satisfy a supplier base rule', { reason: 'invalid_input', constraint: pg.constraint ?? null });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '42501') throw new ApiError('access.forbidden', 'not allowed', { reason: 'row_security' });
  }
  throw error;
}
