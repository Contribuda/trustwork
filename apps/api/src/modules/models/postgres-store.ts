import { sql } from 'kysely';
import { withModelDispatchTransaction } from './dispatch-context.js';
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
import { ModelRefusal, type ModelCallStore, type ModelReceiptStore, type ReservedModelCall } from './ports.js';

const reserved = (row: ModelCallRow): ReservedModelCall => {
  const { prompt: _prompt, ...request } = ModelCallSchema.parse({
    ...(row.request as object),
    prompt: '',
  });
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

/** Owner/session authority is sufficient to settle existing receipts, even after policy or context revocation. */
export class PostgresModelReceiptStore implements ModelReceiptStore {
  constructor(
    protected readonly pool: DataPool,
    protected readonly principal: Principal,
    private readonly receiptBinding: Pick<ModelRuntimeBinding, 'sessionId' | 'authzEpoch'>,
  ) {
    if (principal.authzEpoch !== receiptBinding.authzEpoch) throw new ModelRefusal('authority_mismatch');
  }
  protected as<T>(fn: (trx: Transaction) => Promise<T>) {
    return withPrincipal(this.pool, this.principal, fn);
  }
  async recover(operationId: string, principalId: string) {
    if (principalId !== this.principal.personId) throw new ModelRefusal('authority_mismatch');
    const result = await this.as((trx) => modelCalls.recover(trx, operationId, this.receiptBinding));
    if (result.kind === 'undispatched') return result;
    return result.row.state === 'outcome_unknown'
      ? { kind: 'unknown' as const, call: reserved(result.row) }
      : {
          kind: 'settled' as const,
          metadata: ModelCallMetadataSchema.parse(result.row.metadata),
        };
  }
  async finish(operation: ReservedModelCall, metadata: Parameters<ModelCallStore['finish']>[1]) {
    await this.as(async (trx) => {
      await modelCalls.checkReceiptAuthority(trx, operation.operationId, this.receiptBinding);
      await modelCalls.finish(trx, operation.operationId, operation.dispatchToken, ModelCallMetadataSchema.parse(metadata));
    });
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

/** Bound by authenticated runtime, never exposed as a public request payload. Every method commits independently. */
export class PostgresModelCallStore extends PostgresModelReceiptStore implements ModelCallStore {
  readonly binding: ModelRuntimeBinding;
  constructor(
    pool: DataPool,
    principal: Principal,
    binding: ModelRuntimeBinding,
    private readonly ttlSeconds = 300,
  ) {
    super(pool, principal, binding);
    this.binding = ModelRuntimeBindingSchema.parse(binding);
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
      : {
          kind: 'replay' as const,
          outcome: row.state,
          metadata: row.metadata === null ? null : ModelCallMetadataSchema.parse(row.metadata),
        };
  }
  async fallback(operation: ReservedModelCall, candidate: PinnedCandidate) {
    return reserved(await this.as((trx) => modelCalls.fallback(trx, operation.operationId, operation.dispatchToken, PinnedCandidateSchema.parse(candidate))));
  }
  withDispatchAuthority<T>(operation: ReservedModelCall, invoke: () => Promise<T>): Promise<T> {
    return this.as(async trx => {
      await sql`SELECT set_config('lock_timeout',${String(Math.min(operation.route.limits.timeoutMs,5000))},true)`.execute(trx);
      const checked = await sql<{ allowed: boolean }>`SELECT trustwork.agent_modules_enter_model_effect(${operation.operationId},${operation.dispatchToken}::uuid) AS allowed`.execute(trx);
      if (checked.rows[0]?.allowed !== true) throw new ModelRefusal('dispatch_authority_withdrawn');
      return withModelDispatchTransaction(trx, invoke);
    });
  }
  admit(operation: ReservedModelCall) {
    return this.as((trx) => modelCalls.admit(trx, operation.operationId, operation.dispatchToken));
  }
}
