import type { Generated } from 'kysely';
import { columnsOf, type TableColumns } from './index.js';

/** SANC-007: internal routing evidence, never part of a participant projection. */
export interface ScreeningAppealAssignmentTable {
  appeal_id: string;
  match_id: string;
  original_decision_id: string;
  original_decider: string;
  reviewer_id: string | null;
  assigned_at: Generated<Date>;
}
export interface ScreeningNoticeAuthorityTable {
  delivery_id: string;
  person_id: string;
  binding_id: string;
  created_at: Generated<Date>;
}
export interface ScreeningNoticesDatabase {
  screening_appeal_assignment: ScreeningAppealAssignmentTable;
  screening_notice_authority: ScreeningNoticeAuthorityTable;
  screening_appeal_routing_history: {
    appeal_id: string; version: number; reviewer_id: string | null; assigned_by: string | null;
    reason: string; assigned_at: Generated<Date>;
  };
  screening_appeal_routing_current: { appeal_id: string; version: number };
}
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned tables
  interface Database extends ScreeningNoticesDatabase {}
}
const columns = columnsOf<ScreeningNoticesDatabase>();
export const TABLE_COLUMNS: TableColumns<ScreeningNoticesDatabase> = {
  screening_appeal_assignment: columns('screening_appeal_assignment', ['appeal_id', 'match_id', 'original_decision_id', 'original_decider', 'reviewer_id', 'assigned_at']),
  screening_notice_authority: columns('screening_notice_authority', ['delivery_id', 'person_id', 'binding_id', 'created_at']),
  screening_appeal_routing_history: columns('screening_appeal_routing_history', ['appeal_id', 'version', 'reviewer_id', 'assigned_by', 'reason', 'assigned_at']),
  screening_appeal_routing_current: columns('screening_appeal_routing_current', ['appeal_id', 'version']),
};
