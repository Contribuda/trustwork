import { toCompanyDirectoryEntry, type CompanyDirectoryEntry, type Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { directory, reputationSnapshots, supplierRecords, toSupplierCard, type SupplierCard, type SupplierRecord, type SupplierRecordRow } from './deps.js';
import { screeningOf, type ScreeningView, type SupplierScreeningPort } from './screening.js';
import { recordContract } from './views.js';

/**
 * The buyer-private supplier card (PRC-003 step 3). Every figure comes from the buyer's own records, read under the
 * person's own row-level security; public facts come from the supplier's public projection only (the directory entry
 * and the masked public reputation summary). The card says honestly which sources it counted:
 *
 * - `counted`: read from the buyer's records;
 * - `not_permitted`: the person may not read those records (agreements and orders need company.deals.manage);
 * - `not_applicable`: an external counterparty has no platform agreements or orders;
 * - `not_available`: the module that keeps those records is not live yet (receipts PRC-008, match exceptions and
 *   invoices PRC-010, documents PRC-012); the figure is zero because nothing was counted, not because nothing exists.
 */
export type Coverage = 'counted' | 'not_permitted' | 'not_applicable' | 'not_available';
export interface CardCoverage {
  agreements: Coverage;
  orders: Coverage;
  receipts: Coverage;
  discrepancies: Coverage;
  matchExceptions: Coverage;
  invoices: Coverage;
  documents: Coverage;
}

export interface SupplierCardView {
  audience: 'party_private';
  card: SupplierCard;
  coverage: CardCoverage;
  /** The one screening fact a counterparty may know (SANC-003 port, fail closed). */
  screening: ScreeningView;
  /** What everybody sees of a linked company (its directory entry); null for an external counterparty. */
  publicEntry: CompanyDirectoryEntry | null;
}

const STATUS_OF: Record<string, SupplierCard['publicFacts']['counterpartyStatus']> = { unclaimed: 'sourced', claimed: 'claimed', verified: 'verified' };

export async function buildSupplierCard(trx: Transaction, principal: Principal, row: SupplierRecordRow, screeningPort: SupplierScreeningPort, now: Date): Promise<SupplierCardView> {
  const record: SupplierRecord = recordContract(row);
  const companyId = row.linked_company_id ?? row.linked_sourced_company_id;
  const entryRow = companyId ? await directory.company(trx, companyId) : undefined;
  const publicEntry = entryRow
    ? toCompanyDirectoryEntry({
      id: entryRow.id, handle: entryRow.handle, name: entryRow.display_name, origin: entryRow.sourced_status, claimStatus: entryRow.claim_status,
      legalIdentifiers: entryRow.legal_identifiers as CompanyDirectoryEntry['legalIdentifiers'], publicDescription: entryRow.public_description,
    })
    : null;
  const snapshot = companyId ? await reputationSnapshots.latestPublic(trx, { person: null, company: companyId }) : undefined;
  const mayReadDeals = principal.membership?.permissions.includes('company.deals.manage') ?? false;
  const dealsCoverage: Coverage = companyId === null ? 'not_applicable' : mayReadDeals ? 'counted' : 'not_permitted';
  const counts = companyId !== null && mayReadDeals ? await supplierRecords.ownHistory(trx, { buyerCompanyId: row.owner_company_id, supplierCompanyId: companyId }) : { agreements: 0, orders: 0 };
  const screening = await screeningOf(trx, screeningPort, companyId, now);
  // The hub screens; the buyer never marks screening done. A screening item is complete only when the port says clear.
  const onboarding = record.onboarding.map((item) => (item.kind === 'screening' ? { ...item, state: screening === 'clear' ? 'complete' as const : 'missing' as const } : item));
  const card = toSupplierCard({ ...record, onboarding }, {
    agreements: counts.agreements, orders: counts.orders, receipts: 0, receiptsOnTime: 0, discrepancies: 0, matchExceptions: 0, openInvoices: 0, openInvoiceAmount: null,
    documentsExpiringWithin30Days: 0,
  }, {
    counterpartyStatus: companyId === null ? 'external' : STATUS_OF[publicEntry?.claimStatus ?? 'unclaimed'] ?? 'sourced',
    reputationSnapshotId: snapshot?.id ?? null,
    dueDiligencePackId: null,
  });
  return {
    audience: 'party_private', card, screening, publicEntry,
    coverage: { agreements: dealsCoverage, orders: dealsCoverage, receipts: 'not_available', discrepancies: 'not_available', matchExceptions: 'not_available', invoices: 'not_available', documents: 'not_available' },
  };
}
