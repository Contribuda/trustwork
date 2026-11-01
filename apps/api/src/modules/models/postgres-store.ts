import { computeDigest } from '../../../../../packages/contracts/src/common/digest.js';
import {
  ModelCallMetadataSchema,
  ModelCallSchema,
  ModelRuntimeBindingSchema,
  PinnedCandidateSchema,
  ResolvedModelRouteSchema,
  type ModelCall,
  type ModelRuntimeBinding,
  type PinnedCandidate,
  type ResolvedModelRoute,
} from '../../../../../packages/contracts/src/models.js';
import { withPrincipal, type DataPool, type Principal, type Transaction } from '../../../../../packages/data/src/pool.js';
import { modelCalls } from '../../../../../packages/data/src/repositories/models.js';
import type { ModelCallRow } from '../../../../../packages/data/src/schema/models.js';
import { ModelRefusal, type ModelCallStore, type ReservedModelCall } from './ports.js';

const reserved = (row: ModelCallRow): ReservedModelCall => {
  const { prompt: _prompt, ...request } = ModelCallSchema.parse({ ...(row.request as object), prompt: '' });
  void _prompt;
  return {
    operationId: row.operation_id,
    reservationId: row.reservation_id,
    dispatchToken: row.dispatch_token,
    request,
    route: ResolvedModelRouteSchema.parse(row.route),
    candidate: PinnedCandidateSchema.parse(row.candidate),
  };
};

/** Bound by authenticated runtime, never exposed as a public request payload. Every method commits independently. */
export class PostgresModelCallStore implements ModelCallStore {
  readonly binding: ModelRuntimeBinding;
  constructor(
    private readonly pool: DataPool,
    private readonly principal: Principal,
    binding: ModelRuntimeBinding,
    private readonly ttlSeconds = 300,
  ) {
    this.binding = ModelRuntimeBindingSchema.parse(binding);
    if (principal.authzEpoch !== this.binding.authzEpoch) throw new ModelRefusal('authority_mismatch');
  }
  private as<T>(fn: (trx: Transaction) => Promise<T>) {
    return withPrincipal(this.pool, this.principal, fn);
  }
  async begin(input: ModelCall, route: ResolvedModelRoute, candidate: PinnedCandidate) {
    const call = ModelCallSchema.parse(input);
    if (call.principalId !== this.principal.personId) throw new ModelRefusal('authority_mismatch');
    const digest = computeDigest(call).value;
    const { prompt: _prompt, ...request } = call;
    void _prompt;
    const { fresh, row } = await this.as((trx) =>
      modelCalls.begin(trx, request, this.binding, digest, ResolvedModelRouteSchema.parse(route), PinnedCandidateSchema.parse(candidate), this.ttlSeconds),
    );
    return fresh
      ? { kind: 'dispatch' as const, call: reserved(row) }
      : { kind: 'replay' as const, outcome: row.state, metadata: row.metadata === null ? null : ModelCallMetadataSchema.parse(row.metadata) };
  }
  async fallback(operation: ReservedModelCall, candidate: PinnedCandidate) {
    return reserved(await this.as((trx) => modelCalls.fallback(trx, operation.operationId, operation.dispatchToken, PinnedCandidateSchema.parse(candidate))));
  }
  admit(operation: ReservedModelCall) {
    return this.as((trx) => modelCalls.admit(trx, operation.operationId, operation.dispatchToken));
  }
  async finish(operation: ReservedModelCall, metadata: Parameters<ModelCallStore['finish']>[1]) {
    await this.as((trx) => modelCalls.finish(trx, operation.operationId, operation.dispatchToken, ModelCallMetadataSchema.parse(metadata)));
  }
  async settled(operationId: string, principalId: string) {
    if (principalId !== this.principal.personId) return null;
    const row = await this.as((trx) => modelCalls.get(trx, operationId));
    return row && row.state !== 'outcome_unknown' ? ModelCallMetadataSchema.parse(row.metadata) : null;
  }
  async unknown(operationId: string, principalId: string) {
    if (principalId !== this.principal.personId) return null;
    const row = await this.as((trx) => modelCalls.get(trx, operationId));
    return row?.state === 'outcome_unknown' ? reserved(row) : null;
  }
}
