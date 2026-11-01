import { VersionedTaskFees } from './task-adapter.js';
import type { z } from 'zod';
import { withoutPrincipal } from '../../../common/db.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { hubsRefusal } from '../../hubs/errors.js';
import { billingFees, catalogue, feePricingReaders, PublicPriceSchema, PublicPricingSchema, type ActivateFeeSchema, type CommandContext, type DraftFeeSchema, type PublicPricing } from './deps.js';

/** Governed public prices only. Missing modules are unavailable; they are never quoted as free. */
export class FeesService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, readonly hubId: string | null) {}
  private hub(): string {
    if (!this.hubId) throw new ApiError('access.not_found', 'access.not_found');
    return this.hubId;
  }
  private command(state: RequestState, elevationId: string, reason: string): CommandContext {
    return { elevationId, requestId: state.requestId, reasonCode: 'fee_governance', reasonText: reason };
  }
  private refusal(error: unknown): never {
    const mapped = hubsRefusal(error);
    if (mapped) throw mapped;
    const pg = error as { code?: string; hint?: string };
    if (pg.hint?.startsWith('billing.')) throw new ApiError(pg.code === '42501' ? 'access.forbidden' : 'validation.revision_conflict', 'fee command refused', { reason: pg.hint });
    throw error;
  }
  draft(state: RequestState, elevationId: string, body: z.infer<typeof DraftFeeSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => billingFees.draft(trx, this.command(state, elevationId, body.reason), hub, body.terms)).catch((e: unknown) => this.refusal(e));
  }
  activate(state: RequestState, elevationId: string, id: string, body: z.infer<typeof ActivateFeeSchema>) {
    const hub = this.hub();
    return this.principals.runAs(state, (trx) => billingFees.activate(trx, this.command(state, elevationId, body.reason), hub, id, body.digest, body.approvalId)).catch((e: unknown) => this.refusal(e));
  }
  taskDisclosure(state: RequestState, offerId: string) {
    return this.principals.runAs(state, trx => new VersionedTaskFees(this.hubId).disclose(trx, offerId));
  }
  async publicPricing(): Promise<PublicPricing> {
    if (!this.hubId) return { hubId: null, fees: [], prices: [], unavailable: ['fees', 'plans', 'models', 'capabilities', 'credit_packs'] };
    const fees = await billingFees.publicList(this.ctx.pool, this.hubId);
    const { rows, plans } = await withoutPrincipal(this.ctx.pool, async (trx) => {
      if (!await feePricingReaders.hubAvailable(trx, this.hubId!)) return { rows: [], plans: [] };
      return { rows: await catalogue.publishedPrices(trx, this.hubId!, this.ctx.clock.now()), plans: await feePricingReaders.publishedPlans(trx, this.hubId!) };
    });
    const planByPrice = new Map(plans.map((p) => [p.price_version_id, { id: p.id, version: p.version }]));
    // BILL-001 and merged LLM-001 expose no approved credit-pack validity or model/capability sale-price reader.
    const prices = rows.filter((r) => r.offer_kind !== 'marketplace_fee' && r.offer_kind !== 'credit_pack'
      && (r.offer_kind !== 'plan' || planByPrice.has(r.id))).map((r) => PublicPriceSchema.parse({
      id: r.id, version: r.version, kind: r.offer_kind, code: r.offer_code, currency: r.currency, amountMinor: r.amount_minor,
      effectiveFrom: r.effective_from.toISOString(), effectiveTo: r.effective_to?.toISOString() ?? null, validity: null, planVersion: planByPrice.get(r.id) ?? null,
    }));
    const unavailable: PublicPricing['unavailable'] = ['models', 'capabilities'];
    if (!fees.length) unavailable.push('fees');
    if (!prices.some((p) => p.kind === 'plan')) unavailable.push('plans');
    if (!prices.some((p) => p.kind === 'credit_pack')) unavailable.push('credit_packs');
    return PublicPricingSchema.parse({ hubId: this.hubId, fees, prices, unavailable });
  }
}
