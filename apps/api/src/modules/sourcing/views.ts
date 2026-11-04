import type { Party } from '../../deps/contracts.js';
import { DIGEST_ALGORITHM } from '../../deps/contracts.js';
import {
  AwardDecisionSchema, BidLevelSheetVersionSchema, BidOutcomeNoticeSchema, levelSheetTotals, type AwardDecisionRow, type BidLevelSheetPayload, type BidLevelSheetVersion, type BidLevelSheetVersionRow,
  type BidOutcomeNotice, type BidOutcomeNoticeRow, type QuoteVersionRow,
} from './deps.js';
import { columnState } from './levelling.js';

/** Every sourcing view is the buyer's (`party_private`); sellers have no view of a sheet at all. */
export const privateView = <T extends object>(body: T) => ({ audience: 'party_private' as const, ...body });

export const partyOfOwner = (row: { owner_person_id: string | null; owner_company_id: string | null }): Party =>
  (row.owner_person_id ? { kind: 'person', id: row.owner_person_id } : { kind: 'company', id: row.owner_company_id as string });

export function sheetVersionContract(row: BidLevelSheetVersionRow): BidLevelSheetVersion {
  return BidLevelSheetVersionSchema.parse({
    id: row.id, sheetId: row.sheet_id, version: row.version, rfqVersionId: row.rfq_version_id, status: row.status, payload: row.payload,
    digest: { algorithm: DIGEST_ALGORITHM, value: row.digest }, preparedBy: row.prepared_by_person_id, mandateId: row.mandate_id,
  });
}

/** Column keys whose stored `comparable` no longer matches the quote version: a frozen version keeps what it pinned, the reader learns what changed since. */
export function columnsChanged(version: BidLevelSheetVersion, stored: ReadonlyMap<string, QuoteVersionRow>, now: Date): string[] {
  return (version.payload as BidLevelSheetPayload).columns.flatMap((column) => {
    if (column.kind !== 'quote_version') return [];
    const row = stored.get(column.quoteVersionId);
    // An approver who reads the sheet need not read the quotes: nothing is known about them, so nothing is reported.
    if (!row) return [];
    return columnState(row, version.rfqVersionId, now).comparable === column.comparable ? [] : [column.key];
  });
}

export function sheetVersionView(row: BidLevelSheetVersionRow, stored: ReadonlyMap<string, QuoteVersionRow>, now: Date) {
  const version = sheetVersionContract(row);
  return privateView({ version, revision: row.revision, totals: levelSheetTotals(version.payload), columnsChangedSince: columnsChanged(version, stored, now) });
}

export function awardView(row: AwardDecisionRow) {
  const award = AwardDecisionSchema.parse({
    id: row.id, rfqId: row.rfq_id, bidLevelSheetVersionId: row.bid_level_sheet_version_id, selection: row.selection, reasons: row.reasons, approvalRequestId: row.approval_request_id, status: row.status,
    agreementIds: row.agreement_ids,
  });
  return privateView({ award, digest: { algorithm: DIGEST_ALGORITHM, value: row.digest }, approvalOutcome: row.approval_outcome, revision: row.revision });
}

/** The whole notice, for the recipient and for the buyer alike: the schema has no field for anything else. */
export function noticeContract(row: BidOutcomeNoticeRow): BidOutcomeNotice {
  return BidOutcomeNoticeSchema.parse({
    id: row.id, rfqId: row.rfq_id, recipient: row.recipient_person_id ? { kind: 'person', id: row.recipient_person_id } : { kind: 'company', id: row.recipient_company_id }, outcome: row.outcome,
    feedbackBand: row.feedback_band, reasonCategory: row.reason_category, buyerOptedInToFeedback: row.buyer_opted_in_to_feedback, sentAt: new Date(row.sent_at).toISOString(),
  });
}
