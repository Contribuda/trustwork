import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/**
 * Sourcing module (PRC-004, packages/data/migrations/sourcing; handbook "Sourcing events and bid levelling" in
 * docs/engine/procurement-and-supply.md, data model section 18a). Sheets and eligibility rules are party_private of the
 * buyer: the runtime role reads them under row-level security and writes nothing directly; every change goes through
 * the owner-run `sourcing_*` commands.
 */
export type SheetStatusColumn = 'draft' | 'frozen' | 'superseded';
type ReadOnly<T> = ColumnType<T, never, never>;

export interface BidLevelSheetTable {
  id: Generated<string>;
  rfq_id: string;
  owner_person_id: string | null;
  owner_company_id: string | null;
  current_version_id: string | null;
  created_by_person_id: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type BidLevelSheetRow = Selectable<BidLevelSheetTable>;

export interface BidLevelSheetVersionTable {
  id: Generated<string>;
  sheet_id: string;
  rfq_id: string;
  version: number;
  rfq_version_id: string;
  status: Generated<SheetStatusColumn>;
  payload: ReadOnly<unknown>;
  digest: string;
  prepared_by_person_id: string;
  mandate_id: string | null;
  frozen_at: Date | null;
  frozen_by_person_id: string | null;
  superseded_at: Date | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type BidLevelSheetVersionRow = Selectable<BidLevelSheetVersionTable>;

export interface SourcingEligibilityRuleSetTable {
  rfq_id: string;
  rules: ReadOnly<unknown>;
  updated_by_person_id: string;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type SourcingEligibilityRuleSetRow = Selectable<SourcingEligibilityRuleSetTable>;

export type AwardStatusColumn = 'proposed' | 'in_approval' | 'approved' | 'rejected' | 'executed' | 'cancelled';
export type AwardApprovalOutcomeColumn = 'approved' | 'rejected' | 'returned' | 'withdrawn' | 'expired' | 'superseded';

export interface AwardDecisionTable {
  id: Generated<string>;
  rfq_id: string;
  owner_company_id: string;
  bid_level_sheet_version_id: string;
  selection: ReadOnly<unknown>;
  reasons: ReadOnly<unknown>;
  digest: string;
  approval_request_id: string | null;
  approval_outcome: AwardApprovalOutcomeColumn | null;
  status: Generated<AwardStatusColumn>;
  agreement_ids: Generated<string[]>;
  proposed_by_person_id: string;
  proposed_via: 'person' | 'agent';
  proposed_mandate_id: string | null;
  executed_at: Date | null;
  executed_by_person_id: string | null;
  cancelled_reason: string | null;
  revision: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export type AwardDecisionRow = Selectable<AwardDecisionTable>;

export interface BidOutcomeNoticeTable {
  id: Generated<string>;
  rfq_id: string;
  recipient_person_id: string | null;
  recipient_company_id: string | null;
  outcome: 'awarded' | 'not_awarded' | 'cancelled';
  feedback_band: 'within_5pct' | 'within_15pct' | 'above_15pct' | null;
  reason_category: 'price' | 'lead_time' | 'scope' | 'eligibility' | null;
  buyer_opted_in_to_feedback: boolean;
  sent_at: Generated<Date>;
}
export type BidOutcomeNoticeRow = Selectable<BidOutcomeNoticeTable>;

export interface SourcingDatabase {
  bid_level_sheet: BidLevelSheetTable;
  bid_level_sheet_version: BidLevelSheetVersionTable;
  sourcing_eligibility_rule_set: SourcingEligibilityRuleSetTable;
  award_decision: AwardDecisionTable;
  bid_outcome_notice: BidOutcomeNoticeTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends SourcingDatabase {}
}

const columns = columnsOf<SourcingDatabase>();
export const TABLE_COLUMNS: TableColumns<SourcingDatabase> = {
  bid_level_sheet: columns('bid_level_sheet', ['id', 'rfq_id', 'owner_person_id', 'owner_company_id', 'current_version_id', 'created_by_person_id', 'revision', 'created_at', 'updated_at']),
  bid_level_sheet_version: columns('bid_level_sheet_version', ['id', 'sheet_id', 'rfq_id', 'version', 'rfq_version_id', 'status', 'payload', 'digest', 'prepared_by_person_id', 'mandate_id',
    'frozen_at', 'frozen_by_person_id', 'superseded_at', 'revision', 'created_at', 'updated_at']),
  sourcing_eligibility_rule_set: columns('sourcing_eligibility_rule_set', ['rfq_id', 'rules', 'updated_by_person_id', 'revision', 'created_at', 'updated_at']),
  award_decision: columns('award_decision', ['id', 'rfq_id', 'owner_company_id', 'bid_level_sheet_version_id', 'selection', 'reasons', 'digest', 'approval_request_id', 'approval_outcome', 'status',
    'agreement_ids', 'proposed_by_person_id', 'proposed_via', 'proposed_mandate_id', 'executed_at', 'executed_by_person_id', 'cancelled_reason', 'revision', 'created_at', 'updated_at']),
  bid_outcome_notice: columns('bid_outcome_notice', ['id', 'rfq_id', 'recipient_person_id', 'recipient_company_id', 'outcome', 'feedback_band', 'reason_category', 'buyer_opted_in_to_feedback', 'sent_at']),
};
