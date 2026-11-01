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
export interface ScreeningNoticesDatabase { screening_appeal_assignment: ScreeningAppealAssignmentTable }
declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- module-owned tables
  interface Database extends ScreeningNoticesDatabase {}
}
const columns = columnsOf<ScreeningNoticesDatabase>();
export const TABLE_COLUMNS: TableColumns<ScreeningNoticesDatabase> = {
  screening_appeal_assignment: columns('screening_appeal_assignment', ['appeal_id', 'match_id', 'original_decision_id', 'original_decider', 'reviewer_id', 'assigned_at']),
};
