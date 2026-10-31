import assert from 'node:assert/strict';
import { withMaintenance } from '@trustwork/data';
import type { OwnerRfqView } from '../../packages/contracts/src/commerce.js';
import type { SellerQuoteView } from '../../packages/contracts/src/deals.js';
import { kernelReference, kernelSync } from '../../packages/data/src/repositories/kernel.js';
import type { Client, Harness, Response } from '../backend/helpers/app.js';
import { login, seedPersonas, type PersonaKey } from '../backend/helpers/personas.js';

export const UNTIL = '2027-12-31T00:00:00.000Z';
export const usd = (minorUnits: string) => ({ minorUnits, currency: 'USD' });
export const PERSON = { via: 'person' as const };
const bdate = (date: string) => ({ date, timeZone: 'America/Los_Angeles' });

export function ok<T>(r: Response, status = 200): T {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r.body as T;
}

/** Private constraints with recognisable synthetic amounts (USD 90,000.00 ceiling; USD 28.00 floor; USD 21.00 cost basis). */
export const BUYER_PRIVATE = { budgetCeiling: usd('9000000'), evaluationWeights: { price: '0.7' }, internalNotes: 'PRIVATE-buyer-ceiling-note', shortlist: [] as unknown[] };
export const SELLER_PRIVATE = { floorPrices: { q1: usd('2800') }, marginTargets: { q1: '0.2' }, costBasis: { q1: usd('2100') }, negotiationNotes: 'PRIVATE-seller-floor-note' };
const RFQ_PAYLOAD = {
  title: 'Patio pavers and laying', currency: 'USD', responseDeadline: '2027-02-15T17:00:00.000Z', attachments: [], paymentTermsRequested: 'Net 30', acceptanceCriteria: 'Level within 3 mm per metre',
  deliveryTerms: { location: { region: 'US-CA' }, window: { from: bdate('2027-03-01'), to: bdate('2027-03-31') } },
  lines: [
    { lineId: 'pavers', kind: 'goods', description: 'Concrete pavers, grey', specification: { thickness: '60 mm' }, quantity: { value: '10', unit: 'm2' }, alternativesAllowed: true },
    { lineId: 'laying', kind: 'works', description: 'Lay the pavers', specification: {}, quantity: { value: '1', unit: 'ls' }, alternativesAllowed: false },
  ],
};
export function quotePayload(unitPrice: string, laying = '50000') {
  const goods = 10n * BigInt(unitPrice);
  const total = goods + BigInt(laying);
  return {
    currency: 'USD', paymentTerms: 'Net 30', validity: { until: '2027-06-01T00:00:00.000Z' }, exclusions: ['Permits and inspections'], attachments: [],
    deliveryTerms: { milestones: [{ description: 'Delivery and laying', due: bdate('2027-03-20') }], location: 'Site, San Diego County' },
    totals: { net: usd(total.toString()), tax: usd('0'), gross: usd(total.toString()) },
    lines: [
      { lineId: 'q1', rfqLineId: 'pavers', kind: 'goods', specSnapshot: { thickness: '60 mm' }, offeringVersionRef: null, quantity: { value: '10', unit: 'm2' }, unitPrice: usd(unitPrice), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd(goods.toString()), substitution: null, options: [] },
      { lineId: 'q2', rfqLineId: 'laying', kind: 'works', specSnapshot: {}, offeringVersionRef: null, quantity: { value: '1', unit: 'ls' }, unitPrice: usd(laying), tax: { kind: 'none', ratePercent: null, included: false }, taxAmount: usd('0'), lineTotal: usd(laying), substitution: null, options: [] },
    ],
  };
}

export type Ref = { kind: 'rfq' | 'quote'; id: string; version: number; digest: { algorithm: 'trustwork-digest-1'; value: string } };
export interface World {
  seed: Awaited<ReturnType<typeof seedPersonas>>;
  clients: Record<PersonaKey, Client>;
  supplier: { kind: 'company'; id: string };
  petrParty: { kind: 'person'; id: string };
  carlParty: { kind: 'person'; id: string };
  rfq: OwnerRfqView;
  rfqRef: Ref;
  supplierQuote: Ref;
  carlQuote: Ref;
}

/**
 * The synthetic deal every AGT-001 test uses: Petr (a person) asks for a quote; the supplier company (Boris,
 * administrator with deals and members management; Xenia, member with deals management; Pure, member without
 * permissions) and Carl (a person, a competing seller) each send a quote. The supplier keeps a private floor, Petr a
 * private ceiling. Anna (another company's administrator) is an outsider.
 */
export async function buildWorld(h: Harness): Promise<World> {
  const seed = await seedPersonas(h);
  await withMaintenance(h.db.admin, async (trx) => {
    await kernelSync.apply(trx, await kernelReference.fromRepository());
    await trx.updateTable('membership').set({ role: 'administrator' }).where('id', '=', seed.memberships.boris).execute();
    const at = new Date('2026-10-02T09:00:00Z');
    await trx.insertInto('membership').values({ person_id: seed.people.xenia, company_id: seed.companies.supplier, role: 'member', permissions: ['company.deals.manage'], status: 'active', valid_from: at }).execute();
    await trx.insertInto('membership').values({ person_id: seed.people.pure, company_id: seed.companies.supplier, role: 'member', permissions: [], status: 'active', valid_from: at }).execute();
  });
  const clients = {} as Record<PersonaKey, Client>;
  for (const key of ['petr', 'anna', 'pure', 'boris', 'carl', 'xenia'] as PersonaKey[]) {
    const c = h.client();
    await login(c, key);
    clients[key] = c;
  }
  const { petr, boris, carl } = clients;
  const supplier = { kind: 'company' as const, id: seed.companies.supplier };
  const petrParty = { kind: 'person' as const, id: seed.people.petr };
  const carlParty = { kind: 'person' as const, id: seed.people.carl };
  let rfq = ok<OwnerRfqView>(await petr.post('/v1/rfqs', { owner: petrParty, projectId: null, payload: RFQ_PAYLOAD, category: 'landscaping', publicProjection: { enabled: false, fields: [] }, privateConstraint: BUYER_PRIVATE, source: null, actor: PERSON }), 201);
  rfq = ok<OwnerRfqView>(await petr.post(`/v1/rfqs/${rfq.rfq.id}/publish`, { rfqId: rfq.rfq.id, version: 1, expectedRevision: rfq.rfq.revision, amendmentReason: null, actor: PERSON }));
  for (const party of [supplier, carlParty]) ok(await petr.post(`/v1/rfqs/${rfq.rfq.id}/invitations`, { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, party, channel: 'platform', actor: PERSON }), 201);
  rfq = ok<OwnerRfqView>(await petr.get(`/v1/rfqs/${rfq.rfq.id}`));
  const send = async (client: Client, seller: { kind: 'person' | 'company'; id: string }, unitPrice: string, laying: string, privateConstraint: typeof SELLER_PRIVATE | null) => {
    const created = ok<SellerQuoteView>(await client.post('/v1/quotes', { rfqId: rfq.rfq.id, rfqVersionId: rfq.rfq.currentVersionId, seller, payload: quotePayload(unitPrice, laying), privateConstraint, actor: PERSON }), 201);
    return ok<SellerQuoteView>(await client.post(`/v1/quotes/${created.quote.id}/send`, { quoteId: created.quote.id, version: 1, expectedRevision: created.quote.revision, actor: PERSON }));
  };
  const supplierQuote = await send(boris, supplier, '3000', '50000', SELLER_PRIVATE);
  const carlQuote = await send(carl, carlParty, '3175', '61300', null);
  const quoteRef = (q: SellerQuoteView): Ref => {
    const v = q.versions.find((x) => x.version === 1)!;
    return { kind: 'quote', id: q.quote.id, version: 1, digest: v.digest as Ref['digest'] };
  };
  const current = rfq.versions.find((v) => v.id === rfq.rfq.currentVersionId)!;
  return {
    seed, clients, supplier, petrParty, carlParty, rfq, rfqRef: { kind: 'rfq', id: rfq.rfq.id, version: current.version, digest: current.digest as Ref['digest'] },
    supplierQuote: quoteRef(supplierQuote), carlQuote: quoteRef(carlQuote),
  };
}

/** Company mandate terms over the RFQ context (pre-authorized unless told otherwise). */
export function terms(rfqId: string, actions: string[], over: Record<string, unknown> = {}) {
  return {
    moduleKeys: ['negotiation', 'representative'], actions, contexts: [{ kind: 'rfq', id: rfqId }],
    limits: { ceiling: null, perActionCeiling: null, transactionBudgetId: null, platformBudgetId: null, perWindow: null },
    conditions: [], approvalPolicy: { mode: 'pre_authorized' }, approvers: [], escalation: { kind: 'ask_principal' }, validUntil: UNTIL, ...over,
  };
}
/** An own-agent mandate draft (AST-001 route body). */
export function ownDraft(rfqId: string, actions: string[], over: Record<string, unknown> = {}) {
  return { draft: { onBehalfOf: null, grantee: { kind: 'own_agent' }, ...terms(rfqId, actions), moduleKeys: ['negotiation'], ...over } };
}
export function envelope(over: Record<string, unknown>) {
  return { refs: [], note: null, negotiationSessionId: null, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(), ...over };
}
