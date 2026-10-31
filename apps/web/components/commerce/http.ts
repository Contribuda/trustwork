import { cache } from 'react';
import { z } from 'zod';
import type { Party } from '@trustwork/contracts/client';
import { data } from '@/app/_lib/data';
import type { AuthenticatedPrincipal } from '@/app/_lib/data/types';
import { createTransport, type Transport } from '@/app/_lib/data/http/transport';
import {
  AgreementListSchema,
  BuyerAgreementViewSchema,
  BuyerQuoteViewSchema,
  NeedListSchema,
  NeedSchema,
  OwnerRfqViewSchema,
  QuoteComparisonSchema,
  QuoteListSchema,
  RfqListSchema,
  SellerAgreementViewSchema,
  SellerQuoteViewSchema,
  SupplierInvitationListSchema,
  SupplierRfqViewSchema,
} from './contracts';
import type { CommercePort, SupplierCandidate } from './port';

/**
 * Live commerce adapter (WEB-002) on the COM-001 and COM-002 routes. Reads go through the app's server transport
 * (`GET /v1/*` with the visitor's session cookie, `no-store`, the contract error envelope; 404 `access.not_found` is
 * `null`). Every body is parsed with the contract schema of the projection the API answers before a page sees it, so a
 * field the projection does not define (a counterparty's private half included) fails the parse instead of rendering.
 */
const RfqViewSchema = z.union([OwnerRfqViewSchema, SupplierRfqViewSchema]);
const QuoteViewSchema = z.union([SellerQuoteViewSchema, BuyerQuoteViewSchema]);
const AgreementViewSchema = z.union([BuyerAgreementViewSchema, SellerAgreementViewSchema]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createHttpCommercePort(transport: Transport): CommercePort {
  const get = async <T>(path: `/v1/${string}`, schema: z.ZodType<T>): Promise<T | null> => {
    const body = await transport.get(path);
    return body === null ? null : schema.parse(body);
  };
  const byId = <T>(prefix: string, schema: z.ZodType<T>) => async (id: string): Promise<T | null> => (SAFE_ID.test(id) ? get(`/v1/${prefix}/${encodeURIComponent(id)}`, schema) : null);

  const rfq = cache(byId('rfqs', RfqViewSchema));
  const quote = cache(byId('quotes', QuoteViewSchema));
  const agreement = cache(byId('agreements', AgreementViewSchema));
  const need = cache(byId('needs', NeedSchema));
  const label = cache(async (kind: Party['kind'], id: string): Promise<string | null> => {
    try {
      if (kind === 'company') return (await data.getCompany(id))?.name ?? null;
      return (await data.getPerson(id))?.displayName ?? null;
    } catch {
      return null;
    }
  });

  return {
    source: 'api',
    listNeeds: async () => (await get('/v1/needs', NeedListSchema))?.needs ?? [],
    getNeed: async (_p, id) => need(id),
    listRfqs: async () => (await get('/v1/rfqs', RfqListSchema))?.rfqs ?? [],
    getRfq: async (_p, id) => rfq(id),
    getComparison: async (_p, rfqId, mode) => (SAFE_ID.test(rfqId) ? get(`/v1/rfqs/${encodeURIComponent(rfqId)}/comparison?mode=${mode}`, QuoteComparisonSchema) : null),
    listQuotes: async () => (await get('/v1/quotes', QuoteListSchema))?.quotes ?? [],
    getQuote: async (_p, id) => quote(id),
    listInvitations: async () => (await get('/v1/rfq-invitations', SupplierInvitationListSchema))?.invitations ?? [],
    listAgreements: async () => (await get('/v1/agreements', AgreementListSchema))?.agreements ?? [],
    getAgreement: async (_p, id) => agreement(id),
    partyLabel: async (principal: AuthenticatedPrincipal, party: Party) => {
      if (party.kind === 'person' && party.id === principal.personId) return principal.displayName;
      if (party.kind === 'company' && principal.company?.id === party.id) return principal.company.name;
      return label(party.kind, party.id);
    },
    supplierCandidates: async (principal) => {
      const [companies, people] = await Promise.all([data.listCompanies().catch(() => []), data.listPeople().catch(() => [])]);
      const out: SupplierCandidate[] = [
        ...companies.filter((c) => c.id !== principal.company?.id).map((c) => ({ party: { kind: 'company' as const, id: c.id }, label: c.name, outreach: c.status !== 'sourced' })),
        ...people.filter((p) => p.id !== principal.personId).map((p) => ({ party: { kind: 'person' as const, id: p.id }, label: p.displayName, outreach: true })),
      ];
      return out;
    },
  };
}

export const httpCommercePort: CommercePort = createHttpCommercePort(createTransport());
