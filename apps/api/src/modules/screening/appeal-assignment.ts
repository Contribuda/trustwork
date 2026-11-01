import type {} from '../../../../../packages/data/src/schema/screening-notices.js';
import { AppealAssignmentViewSchema } from '../../../../../packages/contracts/src/screening-notices.js';
import type { Transaction } from '../../deps/data.js';

/** Staff-only routing metadata. Existing screening RLS and the controller's elevation remain authoritative. */
export async function appealAssignment(trx: Transaction, matchId: string) {
  const row = await trx.selectFrom('screening_appeal_assignment').selectAll().where('match_id', '=', matchId).orderBy('assigned_at', 'desc').executeTakeFirst();
  return row ? AppealAssignmentViewSchema.parse({ appealId: row.appeal_id, originalDecisionId: row.original_decision_id, reviewerId: row.reviewer_id, assignedAt: row.assigned_at.toISOString() }) : null;
}
