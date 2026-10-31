import { SubscriptionPlanVersionSchema, catalogue, type PriceVersionRow } from './deps.js';
import type { Transaction } from '../../deps/data.js';

/**
 * Synthetic demo catalogue (BILL-001). Prices for the reference hub are an open owner question (ADR 012, question
 * 7; O03), so nothing here is a real price: every offer code starts with `synthetic_`, every name says "Synthetic",
 * and the amounts are placeholders chosen to be obviously not market prices (zero or one unit of the currency). They
 * exist so the demo and the tests exercise versioning, acceptance, budgets and the ledger end to end. No provider
 * is registered and nothing is ever charged.
 */
export const SYNTHETIC_ACCEPTANCE_TEXT_VERSION = 'synthetic-terms-1';
export const SYNTHETIC_OFFERS = [
  { code: 'synthetic_free_basic', name: 'Synthetic free basic participation', kind: 'plan', amountMinor: '0' },
  { code: 'synthetic_agent_capacity', name: 'Synthetic agent capacity plan (placeholder price)', kind: 'plan', amountMinor: '100' },
  { code: 'synthetic_analytical_report', name: 'Synthetic analytical report (placeholder price)', kind: 'deliverable', amountMinor: '100' },
] as const;
export type SyntheticOfferCode = (typeof SYNTHETIC_OFFERS)[number]['code'];

/** Capacity only: modules, quota, connections and channels. Nothing in a plan reaches ranking, matching or reputation. */
const SYNTHETIC_PLAN_CONTENT = {
  synthetic_free_basic: { payerKind: 'person', moduleKeys: ['core'], includedQuota: [{ moduleKey: 'core', meter: 'model_tokens', units: '200000', window: 'month' }], connections: 1, channels: 1, representativeIncluded: false },
  synthetic_agent_capacity: { payerKind: 'company', moduleKeys: ['core', 'quoting'], includedQuota: [{ moduleKey: 'quoting', meter: 'agent_actions', units: '500', window: 'month' }], connections: 3, channels: 3, representativeIncluded: true },
} as const;

export interface SeededCatalogue { offers: Record<SyntheticOfferCode, { offerId: string; priceVersion: PriceVersionRow; planVersionId: string | null }> }

/**
 * Owner-run (maintenance transaction): creates the synthetic offers, drafts their price versions with `drafter` and
 * activates them with `activator` (a different person; the database refuses the same one). `effectiveFrom` must be in
 * the future: activation never back-dates.
 */
export async function seedSyntheticCatalogue(trx: Transaction, input: { hubId: string; currency: string; drafter: string; activator: string; effectiveFrom: Date }): Promise<SeededCatalogue> {
  const offers = {} as SeededCatalogue['offers'];
  for (const offer of SYNTHETIC_OFFERS) {
    const row = await catalogue.createOffer(trx, { hubId: input.hubId, code: offer.code, name: offer.name, kind: offer.kind, createdBy: input.drafter, status: 'active' });
    const draft = await catalogue.draftPriceVersion(trx, {
      offerId: row.id, amountMinor: offer.amountMinor, currency: input.currency, effectiveFrom: input.effectiveFrom, acceptanceTextVersion: SYNTHETIC_ACCEPTANCE_TEXT_VERSION, draftedBy: input.drafter,
    });
    const priceVersion = await catalogue.activatePriceVersion(trx, draft.id, input.activator);
    let planVersionId: string | null = null;
    const content = offer.code in SYNTHETIC_PLAN_CONTENT ? SYNTHETIC_PLAN_CONTENT[offer.code as keyof typeof SYNTHETIC_PLAN_CONTENT] : null;
    if (content) {
      const plan = SubscriptionPlanVersionSchema.parse({ id: 'pending', offerId: row.id, version: 1, priceVersionId: priceVersion.id, status: 'draft', ...content });
      const { payerKind, moduleKeys, includedQuota, connections, channels, representativeIncluded } = plan;
      const planRow = await catalogue.draftPlanVersion(trx, { offerId: row.id, payerKind, payload: { moduleKeys, includedQuota, connections, channels, representativeIncluded }, priceVersionId: priceVersion.id, draftedBy: input.drafter });
      planVersionId = (await catalogue.activatePlanVersion(trx, planRow.id, input.activator)).id;
    }
    offers[offer.code] = { offerId: row.id, priceVersion, planVersionId };
  }
  return { offers };
}
