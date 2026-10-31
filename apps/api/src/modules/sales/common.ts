import { auditEvents, outbox, type Transaction } from '../../deps/data.js';
import type { Capability, ObjectParticipation, Party, Principal } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PolicyResource } from '../identity/policy/policy.js';
import type { ParticipationService } from '../identity/policy/participation.service.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { mapDatabaseError, partyOf, UUID } from '../procurement/common.js';
import { DEAL_EVENT_PAYLOAD_KEYS, rfqs, type DealActorInput, type PartyScope, type RfqRow } from './deps.js';
import type { DealMandateCheck, DealMandatePort } from './mandates.js';

export { UUID, partyOf };
export const iso = (value: Date | string): string => new Date(value).toISOString();

/** Database hints of the transactions and billing guards, mapped to frozen contract codes (checked before the commerce hints). */
const HINTS: Record<string, { code: ConstructorParameters<typeof ApiError>[0]; reason: string }> = {
  'transactions.not_invited': { code: 'access.forbidden', reason: 'not_invited' },
  'transactions.agreement_live': { code: 'validation.revision_conflict', reason: 'agreement_live' },
  'transactions.terms_kind_unavailable': { code: 'validation.schema', reason: 'terms_kind_unavailable' },
  'transactions.event_missing': { code: 'validation.schema', reason: 'event_missing' },
  'transactions.order_missing': { code: 'validation.schema', reason: 'order_missing' },
  'transactions.unknown_line': { code: 'validation.schema', reason: 'unknown_line' },
  'commercial.digest_mismatch': { code: 'commercial.digest_mismatch', reason: 'digest_mismatch' },
  'commercial.stale_version': { code: 'commercial.stale_version', reason: 'stale_version' },
  'commercial.quote_not_acceptable': { code: 'commercial.quote_not_acceptable', reason: 'quote_not_acceptable' },
  'commercial.quote_expired': { code: 'commercial.quote_expired', reason: 'quote_expired' },
  'commercial.rfq_version_mismatch': { code: 'commercial.rfq_version_mismatch', reason: 'rfq_version_mismatch' },
  'commercial.authority_missing': { code: 'commercial.authority_missing', reason: 'authority_missing' },
  'commercial.budget_insufficient': { code: 'commercial.budget_insufficient', reason: 'budget_insufficient' },
  'commercial.currency_mismatch': { code: 'commercial.currency_mismatch', reason: 'currency_mismatch' },
  'billing.budget_kind_mismatch': { code: 'commercial.authority_missing', reason: 'budget_kind_mismatch' },
  'billing.budget_inactive': { code: 'commercial.budget_insufficient', reason: 'budget_inactive' },
  'billing.scope_mismatch': { code: 'commercial.authority_missing', reason: 'budget_scope_mismatch' },
  'billing.reservation_closed': { code: 'validation.revision_conflict', reason: 'reservation_closed' },
  'validation.idempotency_conflict': { code: 'validation.idempotency_conflict', reason: 'idempotency_conflict' },
  'access.not_found': { code: 'access.not_found', reason: 'not_found' },
};
export function mapDealError(error: unknown): never {
  const pg = error as { code?: string; hint?: string };
  const mapped = pg && typeof pg.code === 'string' && pg.hint ? HINTS[pg.hint] : undefined;
  if (mapped) throw new ApiError(mapped.code, mapped.reason, { reason: mapped.reason });
  return mapDatabaseError(error);
}

export interface ResolvedActor { via: 'person' | 'agent'; personId: string; mandateId: string | null }
export type BuyerSide = { row: RfqRow; rows: ObjectParticipation[]; resource: PolicyResource };
type EventPayload = Partial<Record<(typeof DEAL_EVENT_PAYLOAD_KEYS)[number], string | number | null>>;
const OWNER_SIDE_LAYERS = new Set(['party_private', 'owner_private']);

/**
 * Shared plumbing of the sales and transactions services: one `withPrincipal` transaction per request (the idempotency
 * record completes inside it, BE-005), database hints mapped to contract codes, the actor rule (a person on their own
 * authority, an agent only under a mandate), the buyer side of an RFQ through the access policy, the seller side through
 * the party rule, audit rows and identifiers-only outbox events (MAIL-001 reads projections under the recipient's authority).
 */
export abstract class DealService {
  constructor(
    protected readonly ctx: AppContext,
    protected readonly principals: PrincipalService,
    protected readonly policy: ParticipationService,
    protected readonly mandates: DealMandatePort,
  ) {}

  protected now(): Date {
    return this.ctx.clock.now();
  }

  protected run<T>(state: RequestState, fn: (trx: Transaction, principal: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch(mapDealError);
  }

  /** A person acts for themself; a company through members holding company.deals.manage. */
  protected actsFor(principal: Principal, party: Party): boolean {
    if (party.kind === 'person') return party.id === principal.personId;
    return principal.membership?.companyId === party.id && principal.membership.permissions.includes('company.deals.manage');
  }
  protected scope(principal: Principal): PartyScope {
    return { personId: principal.personId, companyId: principal.membership?.permissions.includes('company.deals.manage') ? principal.membership.companyId : null };
  }

  protected async actor(principal: Principal, input: DealActorInput, action: DealMandateCheck['action'], context: DealMandateCheck['context'], amount: DealMandateCheck['amount'] = null): Promise<ResolvedActor> {
    if (input.via === 'person') return { via: 'person', personId: principal.personId, mandateId: null };
    const ok = await this.mandates.allows({ personId: principal.personId, mandateId: input.mandateId, action, context, amount, at: this.now() });
    if (!ok) throw new ApiError('access.mandate_scope', `the agent needs a ${action} mandate for this object`);
    return { via: 'agent', personId: principal.personId, mandateId: input.mandateId };
  }

  /** The RFQ as the access policy sees it for the principal, or null when it is not readable. */
  protected async loadRfq(trx: Transaction, rfqId: string, lock = false): Promise<BuyerSide | null> {
    if (!UUID.test(rfqId)) return null;
    const row = lock ? await rfqs.lock(trx, rfqId) : await rfqs.get(trx, rfqId);
    if (!row) return null;
    const rows = await this.policy.rowsFor(trx, { kind: 'rfq', id: rfqId });
    return { row, rows, resource: { kind: 'rfq', id: row.id, ownerParty: partyOf(row), lifecycle: row.status, publishedProjection: false } };
  }
  protected isBuyerSide(p: Principal, loaded: BuyerSide | null): loaded is BuyerSide {
    if (!loaded) return false;
    const read = this.policy.evaluate(p, 'read.party_private', loaded.resource, loaded.rows);
    return read.effect === 'allow' && OWNER_SIDE_LAYERS.has(read.projection);
  }
  /** Allowed with a buyer-private projection; otherwise not found (no buyer-side read) or forbidden (read but not this capability). */
  protected requireBuyer(p: Principal, loaded: BuyerSide | null, capability: Capability, readable = false): BuyerSide {
    if (!this.isBuyerSide(p, loaded)) {
      if (readable) throw new ApiError('access.forbidden', 'only the buyer side may do this', { reason: 'not_buyer' });
      throw new ApiError('access.not_found');
    }
    const decision = this.policy.evaluate(p, capability, loaded.resource, loaded.rows);
    if (decision.effect !== 'allow') this.policy.require(decision);
    if (decision.effect === 'allow' && !OWNER_SIDE_LAYERS.has(decision.projection)) throw new ApiError('access.forbidden', 'buyer-side authority is needed');
    return loaded;
  }

  protected async audit(trx: Transaction, principal: Principal, state: RequestState, action: string, objectKind: string, objectId: string, basis: unknown): Promise<void> {
    await auditEvents.append(trx, { actor_person_id: principal.personId, action, object_kind: objectKind, object_id: objectId, request_id: state.requestId, authz_epoch: principal.authzEpoch, basis });
  }

  /** Identifiers only (DEAL_EVENT_PAYLOAD_KEYS). */
  protected async event(trx: Transaction, aggregateKind: 'quote' | 'agreement' | 'order', aggregateId: string, revision: number, type: string, payload: EventPayload): Promise<void> {
    for (const key of Object.keys(payload)) if (!(DEAL_EVENT_PAYLOAD_KEYS as readonly string[]).includes(key)) throw new Error(`event payload key ${key} is not an identifier`);
    await outbox.append(trx, { aggregate_kind: aggregateKind, aggregate_id: aggregateId, revision, type, payload });
  }
}
