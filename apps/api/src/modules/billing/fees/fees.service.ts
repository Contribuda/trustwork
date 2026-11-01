import { VersionedTaskFees } from './task-adapter.js';
import type { z } from 'zod';
import { withoutPrincipal } from '../../../common/db.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { hubsRefusal } from '../../hubs/errors.js';
import { billingFees, feePricingReaders, SubscriptionPlanVersionSchema, PublicPriceSchema, PublicPricingSchema, type ActivateFeeSchema, type CommandContext, type DraftFeeSchema, type PublicPricing } from './deps.js';

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
    const at = this.ctx.clock.now();
    const sections: NonNullable<PublicPricing['coverage']>['sections'] = {
      fees: 'unavailable', plans: 'unavailable', services: 'unavailable',
      models: 'unavailable', capabilities: 'unavailable', credit_packs: 'unavailable',
    };
    const unavailable = () => (['fees', 'plans', 'models', 'capabilities', 'credit_packs'] as const).filter(key => sections[key] !== 'available');
    const empty = (): PublicPricing => ({ hubId: null, fees: [], prices: [], unavailable: ['fees', 'plans', 'models', 'capabilities', 'credit_packs'],
      coverage: { generatedAt: at.toISOString(), sections: { fees: 'unavailable', plans: 'unavailable', services: 'unavailable', models: 'unavailable', capabilities: 'unavailable', credit_packs: 'unavailable' } } });
    if (!this.hubId) return empty();
    const hubId = this.hubId;
    // Hub lookup failures fail the whole request; they cannot authorize an empty catalogue.
    const available = () => withoutPrincipal(this.ctx.pool, trx => feePricingReaders.hubAvailable(trx, hubId));
    if (!await available()) return empty();
    let fees: PublicPricing['fees'] = [];
    const prices: PublicPricing['prices'] = [];
    try {
      fees = (await billingFees.publicList(this.ctx.pool, hubId)).filter(f => f.terms.effectiveTo === null || Date.parse(f.terms.effectiveTo) > at.getTime());
      if (fees.some(f => f.hubId !== hubId)) throw new Error('Invalid public fee hub');
      sections.fees = 'available';
    } catch { fees = []; sections.fees = 'error'; }
    // Each reader owns a transaction. A PostgreSQL failure rolls it back before any sibling read.
    for (const plans of [true, false]) {
      const section = plans ? 'plans' : 'services';
      try {
        const projected = await withoutPrincipal(this.ctx.pool, async trx => {
          const rows = await feePricingReaders.publishedPrices(trx, hubId, at, plans);
          const bindings = plans ? await feePricingReaders.publishedPlans(trx, hubId) : [];
          const byPrice = new Map<string, typeof bindings[number]>();
          for (const binding of bindings) {
            const payload = SubscriptionPlanVersionSchema.parse(binding.payload);
            // The immutable draft payload retains its draft status; activation belongs to the row.
            if (binding.status !== 'active' || !['draft', 'active'].includes(payload.status) || payload.id !== binding.id || payload.version !== binding.version ||
              payload.offerId !== binding.offer_id || payload.priceVersionId !== binding.price_version_id || payload.payerKind !== binding.payer_kind ||
              byPrice.has(binding.price_version_id)) throw new Error('Invalid active plan binding');
            const row = rows.find(r => r.id === binding.price_version_id && r.offer_id === binding.offer_id);
            if (!row) throw new Error('Unavailable active plan price');
            byPrice.set(binding.price_version_id, binding);
          }
          return rows.map(r => {
            const binding = byPrice.get(r.id);
            if (plans && !binding) throw new Error('Unavailable active price plan');
            const payload = binding ? SubscriptionPlanVersionSchema.parse(binding.payload) : null;
            return PublicPriceSchema.parse({
              id: r.id, version: r.version, kind: r.offer_kind, code: r.offer_code, currency: r.currency, amountMinor: r.amount_minor,
              effectiveFrom: r.effective_from.toISOString(), effectiveTo: r.effective_to?.toISOString() ?? null, validity: null,
              planVersion: binding ? { id: binding.id, version: binding.version } : null,
              disclosure: { offerId: r.offer_id, name: r.offer_name, acceptanceTextVersion: r.acceptance_text_version,
                plan: payload ? { payerKind: payload.payerKind, moduleKeys: payload.moduleKeys, includedQuota: payload.includedQuota,
                  connections: payload.connections, channels: payload.channels, representativeIncluded: payload.representativeIncluded } : null },
            });
          });
        });
        prices.push(...projected); sections[section] = 'available';
      } catch { sections[section] = 'error'; }
    }
    // A hub closed during the reads must not leave a published sibling section behind.
    if (!await available()) return empty();
    return PublicPricingSchema.parse({ hubId, fees, prices, unavailable: unavailable(), coverage: { generatedAt: at.toISOString(), sections } });
  }
}
