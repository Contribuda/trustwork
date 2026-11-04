import type { z } from 'zod';
import type { DataPool } from '../../../deps/data.js';
import type { ErrorCode } from '../../../deps/contracts.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import { hubsRefusal } from '../../hubs/errors.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import {
  meteredPrices, type ActivateMeteredPriceSchema, type CancelMeteredPriceSchema, type CommandContext, type DraftMeteredPriceSchema, type PublicMeteredPriceRow, type PublicPrice, type RecordMeteredCostSchema,
} from './deps.js';

const REFUSALS: Readonly<Record<string, ErrorCode>> = {
  'billing.invalid_terms': 'validation.schema',
  'billing.meter_unpriced': 'validation.schema',
  'billing.cost_record_missing': 'validation.schema',
  'billing.backdated': 'validation.schema',
  'billing.version_overlap': 'validation.schema',
  'billing.invalid_transition': 'validation.revision_conflict',
  'billing.subject_priced_elsewhere': 'validation.revision_conflict',
  'billing.unavailable': 'validation.revision_conflict',
  'billing.activator_is_drafter': 'access.second_approver_required',
};
function refusal(error: unknown): never {
  const mapped = hubsRefusal(error);
  if (mapped) throw mapped;
  const hint = (error as { hint?: string }).hint;
  const code = hint ? REFUSALS[hint] : undefined;
  if (code) throw new ApiError(code, 'metered price command refused', { reason: hint });
  throw error;
}

/** Staff commands for agent usage prices, for the server-configured hub. The request body confers no authority. */
export class MeteredPricesService {
  constructor(private readonly principals: PrincipalService, readonly hubId: string | null) {}
  private hub(): string {
    if (!this.hubId) throw new ApiError('access.not_found', 'access.not_found');
    return this.hubId;
  }
  private context(state: RequestState, elevationId: string, reason: string): CommandContext {
    return { elevationId, requestId: state.requestId, reasonCode: 'metered_price_governance', reasonText: reason };
  }
  recordCost(state: RequestState, elevationId: string, body: z.infer<typeof RecordMeteredCostSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => meteredPrices.recordCost(trx, this.context(state, elevationId, body.reason), hub, body.cost)).catch(refusal);
  }
  draft(state: RequestState, elevationId: string, body: z.infer<typeof DraftMeteredPriceSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => meteredPrices.draft(trx, this.context(state, elevationId, body.reason), hub, body.terms)).catch(refusal);
  }
  activate(state: RequestState, elevationId: string, id: string, body: z.infer<typeof ActivateMeteredPriceSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => meteredPrices.activate(trx, this.context(state, elevationId, body.reason), hub, id, body.digest, body.approvalId)).catch(refusal);
  }
  cancel(state: RequestState, elevationId: string, id: string, body: z.infer<typeof CancelMeteredPriceSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => meteredPrices.cancel(trx, this.context(state, elevationId, body.reason), hub, id)).catch(refusal);
  }
  list(state: RequestState, elevationId: string) {
    const hub = this.hub();
    return this.principals.runAs(state, async (trx) => ({ prices: await meteredPrices.staffList(trx, this.context(state, elevationId, 'Read agent usage prices'), hub) })).catch(refusal);
  }
}

const publicKind = (kind: PublicMeteredPriceRow['kind']): PublicPrice['kind'] => (kind === 'model' ? 'model' : kind === 'capability' ? 'capability' : 'agent_module');

/** Rows for the hub's price page: the sale price and its unit, nothing about cost, drafters or approvals. */
export async function publicMeteredPrices(pool: DataPool, hubId: string, at: Date): Promise<PublicPrice[]> {
  return (await meteredPrices.publicList(pool, hubId, at)).map((row) => ({
    id: row.id, version: row.version, kind: publicKind(row.kind), code: row.code, currency: row.currency, amountMinor: row.amountMinor,
    effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, validity: null, planVersion: null,
    disclosure: {
      offerId: row.offerId, name: row.name, acceptanceTextVersion: row.acceptanceTextVersion, plan: null,
      // `sale` is what every model and capability row carries, in raw meter units; `metered` adds the unit and direction.
      sale: { modelId: row.kind === 'model' ? row.key : null, capabilityId: row.kind === 'capability' ? row.key : null, meter: row.meter, perUnits: String(row.unit === 'thousand_tokens' ? row.perUnits * 1000 : row.perUnits) },
      metered: { key: row.key, direction: row.direction, meter: row.meter, unit: row.unit, perUnits: row.perUnits, salePerUnitMinor: row.salePerUnitMinor },
    },
  }));
}
