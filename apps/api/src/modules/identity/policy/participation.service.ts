import { canonicalize, PolicyCacheKeySchema, type Capability, type GrantAudience, type ObjectParticipation, type Party, type PolicyDecision, type Principal, type ResourceRef } from '../../../deps/contracts.js';
import { admission, admissionScopes, auditEvents, outbox, participations, type Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import type { AppContext } from '../context.js';
import { toParticipation } from '../serializers.js';
import { evaluatePolicy, grantAllowed, grantorCapabilities, readableProjection, type PolicyResource } from './policy.js';

export interface GrantRequest { party: Party; side: 'buyer' | 'seller' | 'participant'; capabilities: Capability[]; audience: GrantAudience; validUntil: string | null; onBehalfOfCompany: string | null }

/**
 * Object participation use cases: loading the rows RLS shows the principal, evaluating the policy, caching decisions
 * under `PolicyCacheKey` (epochs + resource revision; a hit with another epoch is a miss) and the grant/revoke
 * commands with the no-amplification check at the command layer (DATA-001 items R3/R5/R6).
 */
export class ParticipationService {
  private readonly cache = new Map<string, { decision: PolicyDecision; expiresAt: number }>();
  readonly cacheStats = { hits: 0, misses: 0 };
  constructor(private readonly ctx: AppContext) {}

  async rowsFor(trx: Transaction, resource: ResourceRef): Promise<ObjectParticipation[]> {
    const rows = await participations.listForResource(trx, resource.kind, resource.id);
    return rows.map(toParticipation);
  }

  evaluate(principal: Principal | null, action: Capability, resource: PolicyResource, rows: readonly ObjectParticipation[]): PolicyDecision {
    return evaluatePolicy({ principal, action, resource, participations: rows, now: this.ctx.clock.now() });
  }

  /** Throws the disclosure-correct error for a deny decision. */
  require(decision: PolicyDecision): asserts decision is Extract<PolicyDecision, { effect: 'allow' }> {
    if (decision.effect === 'allow') return;
    if (decision.disclose === 'step_up') throw new ApiError('auth.step_up_required');
    if (decision.reason === 'email_unverified') throw new ApiError('auth.email_unverified');
    if (decision.reason === 'participation_expired') throw new ApiError('access.participation_expired');
    if (decision.reason === 'mandate_scope') throw new ApiError('access.mandate_scope');
    if (decision.reason === 'mandate_revoked') throw new ApiError('access.mandate_revoked');
    if (decision.reason === 'membership_permission_missing' && decision.disclose === 'forbidden') throw new ApiError('membership.permission_missing');
    throw new ApiError(decision.disclose === 'forbidden' ? 'access.forbidden' : 'access.not_found');
  }

  /** Highest readable projection, cached per (person, epochs, resource revision). */
  readable(principal: Principal | null, resource: PolicyResource, rows: readonly ObjectParticipation[], resourceRevision: number): ReturnType<typeof readableProjection> {
    const now = this.ctx.clock.now();
    if (principal) {
      const key = PolicyCacheKeySchema.parse({
        personId: principal.personId, personEpoch: principal.authzEpoch, companyEpoch: principal.membership?.companyAuthzEpoch ?? null,
        resourceKind: resource.kind, resourceId: resource.id, resourceRevision, projection: 'owner_private',
      });
      const storageKey = canonicalize(key);
      const hit = this.cache.get(storageKey);
      if (hit && hit.expiresAt > now.getTime() && hit.decision.effect === 'allow') {
        this.cacheStats.hits += 1;
        return { projection: hit.decision.projection, decision: hit.decision };
      }
      this.cacheStats.misses += 1;
      const result = readableProjection({ principal, resource, participations: rows, now });
      if (result) {
        const nearestExpiry = rows.map((r) => (r.validUntil ? Date.parse(r.validUntil) : Number.POSITIVE_INFINITY)).reduce((a, b) => Math.min(a, b), now.getTime() + 60_000);
        if (this.cache.size > 2_000) this.cache.clear();
        this.cache.set(storageKey, { decision: result.decision, expiresAt: Math.min(nearestExpiry, now.getTime() + 60_000) });
      }
      return result;
    }
    return readableProjection({ principal, resource, participations: rows, now });
  }

  /** Grant within `canGrant` of the grantor's effective capabilities; the owner row is never granted this way. */
  async grant(trx: Transaction, principal: Principal, resource: PolicyResource, rows: readonly ObjectParticipation[], request: GrantRequest, requestId: string): Promise<ObjectParticipation> {
    this.require(this.evaluate(principal, 'manage_participants', resource, rows));
    const grantor = grantorCapabilities(principal, resource, rows, this.ctx.clock.now());
    if (!grantAllowed(grantor, { capabilities: request.capabilities, audience: request.audience })) {
      throw new ApiError('access.forbidden', 'grant exceeds the capabilities or audience held by the grantor', { reason: 'no_amplification' });
    }
    if (request.capabilities.some((c) => c === 'transfer_ownership')) throw new ApiError('access.forbidden', 'ownership is transferred, never granted', { reason: 'owner_only' });
    const row = await participations.grant(trx, {
      resource_kind: resource.kind, resource_id: resource.id,
      party_person_id: request.party.kind === 'person' ? request.party.id : null,
      party_company_id: request.party.kind === 'company' ? request.party.id : null,
      side: request.side, capabilities: request.capabilities, audience: request.audience,
      valid_until: request.validUntil ? new Date(request.validUntil) : null,
      granted_by_person_id: principal.personId,
      on_behalf_of_company_id: request.onBehalfOfCompany,
    });
    await auditEvents.append(trx, { actor_person_id: principal.personId, action: 'participation.granted', object_kind: resource.kind, object_id: resource.id, request_id: requestId, authz_epoch: principal.authzEpoch, basis: { participationId: row.id, party: request.party, capabilities: request.capabilities, audience: request.audience } });
    await outbox.append(trx, { aggregate_kind: resource.kind, aggregate_id: resource.id, revision: row.revision, type: 'participation.granted', payload: { participationId: row.id } });
    return toParticipation(row);
  }

  /** Revoke by a manager or by the party itself; the live owner row is protected (R6) — ownership moves by transfer. */
  async revoke(trx: Transaction, principal: Principal, resource: PolicyResource, rows: readonly ObjectParticipation[], participationId: string, expectedRevision: number, reason: string, requestId: string): Promise<ObjectParticipation> {
    const target = rows.find((r) => r.id === participationId);
    if (!target) throw new ApiError('access.not_found');
    const self = (target.party.kind === 'person' && target.party.id === principal.personId);
    if (!self) this.require(this.evaluate(principal, 'manage_participants', resource, rows));
    if (target.side === 'owner' && target.revokedAt === null) throw new ApiError('access.forbidden', 'the owner row is revoked only by an ownership transfer', { reason: 'owner_row_protected' });
    if (target.revision !== expectedRevision) throw new ApiError('validation.revision_conflict');
    const updated = await participations.revoke(trx, participationId, expectedRevision, reason, this.ctx.clock.now());
    if (!updated) throw new ApiError('validation.revision_conflict');
    const scopes = [admissionScopes.resource(resource.kind, resource.id), target.party.kind === 'person' ? admissionScopes.person(target.party.id) : admissionScopes.company(target.party.id)];
    await admission.revokeMany(trx, scopes, `participation ${participationId} revoked`);
    if (target.party.kind === 'person') await this.ctx.mandates.revokeForPerson(target.party.id, null, `participation ${participationId} revoked`);
    await auditEvents.append(trx, { actor_person_id: principal.personId, action: 'participation.revoked', object_kind: resource.kind, object_id: resource.id, request_id: requestId, authz_epoch: principal.authzEpoch, reason, basis: { participationId } });
    await outbox.append(trx, { aggregate_kind: resource.kind, aggregate_id: resource.id, revision: updated.revision, type: 'participation.revoked', payload: { participationId, scopes } });
    return toParticipation(updated);
  }
}
