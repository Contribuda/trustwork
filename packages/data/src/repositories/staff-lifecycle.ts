import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext, StaffTarget } from './admin.js';
import type { StaffRoleAssignmentRow } from '../schema/admin.js';
import type { MyStaffInvitationRow, StaffDirectoryRow, StaffInvitationRow } from '../schema/staff-lifecycle.js';
import '../schema/staff-lifecycle.js';

/**
 * Staff lifecycle and access governance (ADM-004, migration packages/data/migrations/staff-lifecycle; contract
 * packages/contracts/src/staff-lifecycle.ts).
 *
 * - **Reads** under `withPrincipal`: the staff directory of a hub (names for every staff member covering it; roles and
 *   second-factor state only with `admin.staff.read`), one person's active assignments covering the hub for the
 *   effective-access query, the invitations of a scope (row-level security: `admin.staff.read`), and the invitee's own
 *   open invitations. The directory reads answer "not found" (`admin.not_found`) to anyone who is not staff of the hub.
 * - **Commands**: invite (`admin.staff.assign`, elevated), respond (the invitee, by a verified address, with a second
 *   factor to accept), apply (the inviter, elevated; a sensitive role asks a second person first) and withdraw.
 */
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const scopeArgs = (scope: StaffTarget) => ({
  kind: scope.kind, node: scope.kind === 'node' ? scope.nodeId : null, hub: scope.kind === 'hub' ? scope.hubId : null,
});

export const staffLifecycle = {
  async directory(trx: Transaction, hubId: string): Promise<StaffDirectoryRow[]> {
    const { rows } = await sql<StaffDirectoryRow>`SELECT * FROM trustwork.staff_directory(${hubId}::uuid)`.execute(trx);
    return rows;
  },
  async effectiveAssignments(trx: Transaction, hubId: string, personId: string): Promise<StaffRoleAssignmentRow[]> {
    const { rows } = await sql<StaffRoleAssignmentRow>`SELECT * FROM trustwork.staff_effective_assignments(${hubId}::uuid, ${personId}::uuid)`.execute(trx);
    return rows;
  },

  async invite(trx: Transaction, ctx: CommandContext, input: { email: string; role: string; scope: StaffTarget; definitionVersion: number; validForSeconds: number | null }): Promise<StaffInvitationRow> {
    const s = scopeArgs(input.scope);
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invite(${ctxJson(ctx)}::jsonb, ${input.email}::text, ${input.role}::text, ${s.kind}::text,
      ${s.node}::uuid, ${s.hub}::uuid, ${input.definitionVersion}::integer, ${input.validForSeconds}::bigint)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  async respond(trx: Transaction, invitationId: string, accept: boolean): Promise<StaffInvitationRow> {
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invitation_respond(${invitationId}::uuid, ${accept}::boolean)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  async apply(trx: Transaction, ctx: CommandContext, invitationId: string): Promise<{ invitation: StaffInvitationRow; outcome: 'applied' | 'pending_second_person' }> {
    const { rows } = await sql<{ invitation: StaffInvitationRow; outcome: 'applied' | 'pending_second_person' }>`SELECT to_jsonb(r.invitation) AS invitation, r.outcome
      FROM trustwork.staff_invitation_apply(${ctxJson(ctx)}::jsonb, ${invitationId}::uuid) r`.execute(trx);
    const row = rows[0]!;
    return { invitation: row.invitation, outcome: row.outcome };
  },
  async withdraw(trx: Transaction, ctx: CommandContext, invitationId: string): Promise<StaffInvitationRow> {
    const { rows } = await sql<StaffInvitationRow>`SELECT * FROM trustwork.staff_invitation_withdraw(${ctxJson(ctx)}::jsonb, ${invitationId}::uuid)`.execute(trx);
    return rows[0] as StaffInvitationRow;
  },
  /** Invitations of a hub (and of the node and platform) the reader may see under row-level security, newest first. */
  async invitations(trx: Transaction, hubId: string): Promise<StaffInvitationRow[]> {
    return trx.selectFrom('staff_invitation').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]))
      .orderBy('created_at', 'desc').limit(200).execute();
  },
  async mine(trx: Transaction): Promise<MyStaffInvitationRow[]> {
    const { rows } = await sql<MyStaffInvitationRow>`SELECT * FROM trustwork.staff_my_invitations()`.execute(trx);
    return rows;
  },
};
