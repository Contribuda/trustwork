import { PublicPricingSchema, type PublicPricing } from '@trustwork/contracts/client';
import { computeDigest } from '../../../../../../packages/contracts/src/common/digest.js';

/** Validate only the owning public projection; never fall back to billing tables or demo rates. */
export function publicPricingProjection(input: unknown): PublicPricing {
  const result = PublicPricingSchema.parse(input);
  if (!result.hubId && (result.fees.length || result.prices.length)) throw new Error('Pricing has no serving hub');
  if (!result.hubId && result.coverage && Object.values(result.coverage.sections).some(s => s !== 'unavailable')) throw new Error('Unconfigured pricing coverage');
  const seen = new Set<string>();
  for (const fee of result.fees) {
    if (fee.hubId !== result.hubId) throw new Error('Pricing fee has another serving hub');
    if (result.coverage && result.coverage.sections.fees !== 'available') throw new Error('Unavailable fee reader published rows');
    const expected = computeDigest({ action: 'billing.activate_fee_version', id: fee.id, hubId: fee.hubId, version: fee.version, terms: fee.terms }).value;
    if (fee.digest !== expected) throw new Error('Pricing fee digest mismatch');
    if (seen.has(fee.id)) throw new Error('Duplicate pricing version');
    seen.add(fee.id);
  }
  for (const price of result.prices) {
    if (seen.has(price.id)) throw new Error('Duplicate pricing version');
    seen.add(price.id);
    if (price.effectiveTo && Date.parse(price.effectiveTo) <= Date.parse(price.effectiveFrom)) throw new Error('Invalid price interval');
    if ((price.kind === 'plan') !== (price.planVersion !== null)) throw new Error('Invalid public plan binding');
    if (price.disclosure && (price.kind === 'plan') !== (price.disclosure.plan !== null)) throw new Error('Invalid plan disclosure');
    const section = price.kind === 'plan' ? 'plans' : price.kind === 'model' ? 'models' : price.kind === 'capability' ? 'capabilities' : price.kind === 'credit_pack' ? 'credit_packs' : 'services';
    if (result.coverage && result.coverage.sections[section] !== 'available') throw new Error('Unavailable price reader published rows');
    if (price.kind === 'credit_pack' && !price.validity?.trim()) throw new Error('Credit validity is unavailable');
  }
  return result;
}
