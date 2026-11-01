import { sql } from 'kysely';
import type {} from '../schema/screening-notices.js';
import type { Transaction } from '../pool.js';
import { AppealAssignmentViewSchema } from '../../../contracts/src/screening-notices.js';
import type { CommandContext } from './admin.js';

/** Hold the verified event-time binding through the transport effect in this transaction. */
export async function screeningNoticeAllowed(trx: Transaction, deliveryId: string): Promise<boolean> {
  const { rows } = await sql<{ allowed: boolean }>`SELECT trustwork.screening_notice_allowed(${deliveryId}::uuid) AS allowed`.execute(trx);
  return rows[0]?.allowed === true;
}

export async function currentAppealAssignment(trx: Transaction, matchId: string) {
  const { rows } = await sql<{ value: unknown }>`SELECT trustwork.screening_appeal_assignment_view(${matchId}::uuid) AS value`.execute(trx);
  return rows[0]?.value ? AppealAssignmentViewSchema.parse(rows[0].value) : null;
}

export async function reassignScreeningAppeal(trx: Transaction, ctx: CommandContext, input: {
  matchId: string; expectedVersion: number; reviewerId: string | null; reason: string;
}) {
  const { rows } = await sql<{ value: unknown }>`SELECT trustwork.screening_reassign_appeal(${JSON.stringify(ctx)}::jsonb,
    ${input.matchId}::uuid, ${input.expectedVersion}::integer, ${input.reviewerId}::uuid, ${input.reason}::text) AS value`.execute(trx);
  return AppealAssignmentViewSchema.parse(rows[0]?.value);
}
