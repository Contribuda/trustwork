import type { z } from 'zod';
import type { Party } from '@trustwork/contracts/client';
import type { AuthenticatedPrincipal } from '@/app/_lib/data/types';
import type {
  AgreementListSchema,
  BuyerAgreementView,
  BuyerQuoteView,
  Need,
  NeedListSchema,
  OwnerRfqView,
  QuoteComparison,
  QuoteListSchema,
  RfqListSchema,
  SellerAgreementView,
  SellerQuoteView,
  SupplierInvitationListSchema,
  SupplierRfqView,
} from './contracts';

export type NeedListItem = z.infer<typeof NeedListSchema>['needs'][number];
export type RfqListItem = z.infer<typeof RfqListSchema>['rfqs'][number];
export type QuoteListItem = z.infer<typeof QuoteListSchema>['quotes'][number];
export type InvitationItem = z.infer<typeof SupplierInvitationListSchema>['invitations'][number];
export type AgreementListItem = z.infer<typeof AgreementListSchema>['agreements'][number];
export type RfqView = OwnerRfqView | SupplierRfqView;
export type QuoteView = SellerQuoteView | BuyerQuoteView;
export type AgreementView = BuyerAgreementView | SellerAgreementView;

/** A party the buyer may invite: from the public directories, with whether outreach is permitted (sourced pages are not). */
export type SupplierCandidate = { party: Party; label: string; outreach: boolean };

/**
 * The commerce data boundary of the workspace (WEB-002), next to the app's `DataPort` (whose files belong to WEB-006 and
 * WEB-004): every read is under the signed-in person's own authority and returns exactly the contract projection the
 * API answers for them (`owner_private`, `shared_party` or `party_private`). `null` means not found or not visible
 * (pages answer 404 and never disclose existence). The live adapter reads `/v1/*`; the demo adapter serves synthetic
 * projections built from the demo fixtures (`TRUSTWORK_DEMO_MODE=1`). Mutations never go through here: client
 * components post to the same-origin `/v1/*` route with the CSRF header and an idempotency key.
 */
export interface CommercePort {
  readonly source: 'fixtures' | 'api';
  listNeeds(principal: AuthenticatedPrincipal): Promise<NeedListItem[]>;
  getNeed(principal: AuthenticatedPrincipal, id: string): Promise<Need | null>;
  listRfqs(principal: AuthenticatedPrincipal): Promise<RfqListItem[]>;
  getRfq(principal: AuthenticatedPrincipal, id: string): Promise<RfqView | null>;
  getComparison(principal: AuthenticatedPrincipal, rfqId: string, mode: 'current' | 'historical'): Promise<QuoteComparison | null>;
  listQuotes(principal: AuthenticatedPrincipal): Promise<QuoteListItem[]>;
  getQuote(principal: AuthenticatedPrincipal, id: string): Promise<QuoteView | null>;
  listInvitations(principal: AuthenticatedPrincipal): Promise<InvitationItem[]>;
  listAgreements(principal: AuthenticatedPrincipal): Promise<AgreementListItem[]>;
  getAgreement(principal: AuthenticatedPrincipal, id: string): Promise<AgreementView | null>;
  /** Public name of a party (directory projection), or null when it has no public page. */
  partyLabel(principal: AuthenticatedPrincipal, party: Party): Promise<string | null>;
  /** Companies and people a buyer may invite, without the principal itself and its employer. */
  supplierCandidates(principal: AuthenticatedPrincipal): Promise<SupplierCandidate[]>;
}
