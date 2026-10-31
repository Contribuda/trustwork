import { withoutPrincipal } from '../../common/db.js';
import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import type { Party, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { COMMERCE_EVENT_PAYLOAD_KEYS, type CommerceActorInput } from './deps.js';
import type { CommerceMandateCheck, CommerceMandatePort } from './mandates.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Database hints of the commerce guards, mapped to frozen contract codes (the shared filter does not know them). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'commerce.version_frozen': { code: 'commercial.version_immutable', reason: 'version_frozen' },
  'commercial.version_frozen': { code: 'commercial.version_immutable', reason: 'version_frozen' },
  'commerce.retained': { code: 'commercial.version_immutable', reason: 'retained' },
  'commerce.invalid_transition': { code: 'validation.schema', reason: 'invalid_transition' },
  'commerce.not_authorised': { code: 'access.forbidden', reason: 'not_authorised' },
  'commerce.rfq_version_not_current': { code: 'commercial.rfq_version_not_current', reason: 'rfq_version_not_current' },
  'commerce.stale_immutable': { code: 'validation.schema', reason: 'stale_immutable' },
  'commerce.self_invitation': { code: 'validation.schema', reason: 'self_invitation' },
  'commerce.unknown_unit': { code: 'validation.unit_mismatch', reason: 'unknown_unit' },
  'commerce.restricted_place': { code: 'validation.schema', reason: 'restricted_place' },
  'commerce.parts_missing': { code: 'validation.schema', reason: 'parts_missing' },
  'commerce.component_unpublished': { code: 'validation.schema', reason: 'component_unpublished' },
  'commerce.project_mismatch': { code: 'validation.schema', reason: 'project_mismatch' },
  'commerce.plan_item_path': { code: 'validation.schema', reason: 'plan_item_path' },
  'commerce.not_found': { code: 'access.not_found', reason: 'not_found' },
  'plans.item_path_taken': { code: 'validation.revision_conflict', reason: 'item_path_taken' },
};
export function mapDatabaseError(error: unknown): never {
  const pg = error as { code?: string; hint?: string; constraint?: string };
  if (pg && typeof pg.code === 'string') {
    const mapped = pg.hint ? HINTS[pg.hint] : undefined;
    if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
    if (pg.code === '23503') throw new ApiError('validation.schema', 'a referenced party or record does not exist', { reason: 'unknown_reference' });
    if (pg.code === '23505') throw new ApiError('validation.revision_conflict', 'a conflicting record already exists', { constraint: pg.constraint ?? null });
    if (pg.code === '42501') throw new ApiError('access.forbidden', 'not allowed', { reason: 'row_security' });
  }
  throw error;
}

export function partyOf(row: { owner_person_id: string | null; owner_company_id: string | null }): Party {
  return row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string };
}
export function ownerColumns(party: Party): { owner_person_id: string | null; owner_company_id: string | null } {
  return party.kind === 'person' ? { owner_person_id: party.id, owner_company_id: null } : { owner_person_id: null, owner_company_id: party.id };
}
export const iso = (value: Date | string): string => new Date(value).toISOString();
/** node-postgres parses `date` as local midnight; local getters give back the calendar date in every time zone. */
export function isoDate(value: string | Date): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export interface ResolvedActor { via: 'person' | 'agent'; personId: string; mandateId: string | null }
type EventPayload = Partial<Record<(typeof COMMERCE_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;

/**
 * Shared plumbing of the catalogue and procurement services: one `withPrincipal` transaction per request (the
 * idempotency record completes inside it, BE-005), database hints mapped to contract codes, the actor rule (a person on
 * their own authority, an agent only under a mandate), audit rows and identifiers-only outbox events.
 */
export abstract class CommerceService {
  constructor(protected readonly ctx: AppContext, protected readonly principals: PrincipalService, protected readonly mandates: CommerceMandatePort) {}

  protected now(): Date {
    return this.ctx.clock.now();
  }

  protected run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapDatabaseError);
  }

  /** Signed-in reads run under the principal; anonymous reads only through the owner-run public functions. */
  protected read<T>(state: RequestState, signedIn: (trx: Transaction, principal: Principal) => Promise<T>, anonymous: (trx: Transaction) => Promise<T>): Promise<T> {
    return (state.principal ? this.principals.runAs(state, signedIn) : withoutPrincipal(this.ctx.pool, anonymous)).catch(mapDatabaseError);
  }

  protected async actor(principal: Principal, input: CommerceActorInput, action: CommerceMandateCheck['action'], context: CommerceMandateCheck['context']): Promise<ResolvedActor> {
    if (input.via === 'person') return { via: 'person', personId: principal.personId, mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, action, context, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this object`);
    return { via: 'agent', personId: principal.personId, mandateId: input.mandateId };
  }

  protected async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }

  /** Identifiers only (COMMERCE_EVENT_PAYLOAD_KEYS): notifications read the projection under the recipient's authority. */
  protected async event(trx: Transaction, aggregateKind: 'offering' | 'need' | 'rfq', aggregateId: string, revision: number, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(COMMERCE_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision, type, payload });
  }
}
