/**
 * Relative re-exports of the commerce slice 2 (COM-002). The sales and transactions modules import their contract and
 * repository files directly so the shared package entries (`packages/contracts/src/client.ts`,
 * `packages/data/src/index.ts`) stay untouched; adding them to those barrels is integrator bookkeeping.
 */
export * from '../../../../../packages/contracts/src/deals.js';
export {
  acceptanceEvents, agreementBuyerPrivate, agreements, agreementSellerPrivate, amendmentRequests, negotiationRounds, obligations, orderChanges, orders, quoteLines, quotePrivate, quotes,
  quoteVersions, taxDeterminations, type AcceptanceEventInsert, type ObligationInsert, type PartyScope, type QuoteLineInsert, type TaxDeterminationInsert,
} from '../../../../../packages/data/src/repositories/transactions.js';
export type {
  AcceptanceEventRow, AgreementBuyerPrivateRow, AgreementRow, AgreementSellerPrivateRow, AmendmentRequestRow, CommercialOrderRow, NegotiationRoundRow, ObligationRow, OrderChangeRow,
  QuotePrivateConstraintRow, QuoteRow, QuoteVersionRow,
} from '../../../../../packages/data/src/schema/transactions.js';
export { reservations } from '../../../../../packages/data/src/repositories/billing.js';
export { rfqInvitations, rfqPrivate, rfqs, rfqVersions } from '../procurement/deps.js';
export type { RfqInvitationRow, RfqRow, RfqVersionRow } from '../procurement/deps.js';
