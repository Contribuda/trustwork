import { sql } from 'kysely';
import type { Transaction } from '../pool.js';
import type { CommandContext, StaffTarget } from './admin.js';
import type { StaffRoleAssignmentRow } from '../schema/admin.js';
import type { MyStaffInvitationRow, StaffActivationJoinedRow, StaffActivationRow, StaffDirectoryRow, StaffEligibleRoleRow, StaffInvitationRow } from '../schema/staff-lifecycle.js';
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
 * - **Eligible roles** (part 3): grant and revoke an eligibility (`admin.staff.assign` / `admin.staff.revoke`); the
 *   eligible person requests an activation with a fresh second factor (a non-sensitive role is active at once, a
 *   sensitive one asks a second person), a second person decides, the holder or `admin.staff.revoke` ends it early.
 *   The activation is an ordinary ADM-001 assignment with an end; nothing runs when the window ends.
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

  /* ---------- Part 3: eligible roles and activations ---------- */

  async grantEligible(trx: Transaction, ctx: CommandContext, input: { personId: string; role: string; scope: StaffTarget; definitionVersion: number; maxActivationSeconds: number; validForSeconds: number | null }): Promise<StaffEligibleRoleRow> {
    const s = scopeArgs(input.scope);
    const { rows } = await sql<StaffEligibleRoleRow>`SELECT * FROM trustwork.staff_grant_eligible_role(${ctxJson(ctx)}::jsonb, ${input.personId}::uuid, ${input.role}::text, ${s.kind}::text,
      ${s.node}::uuid, ${s.hub}::uuid, ${input.definitionVersion}::integer, ${input.maxActivationSeconds}::bigint, ${input.validForSeconds}::bigint)`.execute(trx);
    return rows[0] as StaffEligibleRoleRow;
  },
  async revokeEligible(trx: Transaction, ctx: CommandContext, eligibleRoleId: string): Promise<StaffEligibleRoleRow> {
    const { rows } = await sql<StaffEligibleRoleRow>`SELECT * FROM trustwork.staff_revoke_eligible_role(${ctxJson(ctx)}::jsonb, ${eligibleRoleId}::uuid)`.execute(trx);
    return rows[0] as StaffEligibleRoleRow;
  },
  async requestActivation(trx: Transaction, ctx: CommandContext, eligibleRoleId: string, windowSeconds: number): Promise<{ activation: StaffActivationRow; outcome: 'active' | 'pending_second_person' }> {
    const { rows } = await sql<{ activation: StaffActivationRow; outcome: 'active' | 'pending_second_person' }>`SELECT to_jsonb(r.activation) AS activation, r.outcome
      FROM trustwork.staff_activation_request(${ctxJson(ctx)}::jsonb, ${eligibleRoleId}::uuid, ${windowSeconds}::bigint) r`.execute(trx);
    const row = rows[0]!;
    return { activation: row.activation, outcome: row.outcome };
  },
  async decideActivation(trx: Transaction, ctx: CommandContext, activationId: string, decision: 'approve' | 'decline'): Promise<StaffActivationRow> {
    const { rows } = await sql<StaffActivationRow>`SELECT * FROM trustwork.staff_activation_decide(${ctxJson(ctx)}::jsonb, ${activationId}::uuid, ${decision}::text)`.execute(trx);
    return rows[0] as StaffActivationRow;
  },
  async endActivation(trx: Transaction, ctx: CommandContext, activationId: string): Promise<StaffActivationRow> {
    const { rows } = await sql<StaffActivationRow>`SELECT * FROM trustwork.staff_activation_end(${ctxJson(ctx)}::jsonb, ${activationId}::uuid)`.execute(trx);
    return rows[0] as StaffActivationRow;
  },
  /** Eligible roles covering a hub (hub, node and platform) the reader may see: their own, or all with `admin.staff.read`. */
  async eligibleRoles(trx: Transaction, hubId: string, personId?: string): Promise<StaffEligibleRoleRow[]> {
    let query = trx.selectFrom('staff_eligible_role').selectAll().where((eb) => eb.or([eb('hub_id', '=', hubId), eb('scope_kind', 'in', ['node', 'platform'])]));
    if (personId) query = query.where('person_id', '=', personId);
    return query.orderBy('created_at', 'desc').limit(500).execute();
  },
  /** Activations covering a hub, newest first, with what their assignment and approval say now. */
  async activations(trx: Transaction, hubId: string, personId?: string): Promise<StaffActivationJoinedRow[]> {
    let query = trx.selectFrom('staff_activation as a')
      .leftJoin('staff_role_assignment as s', 's.id', 'a.assignment_id')
      .leftJoin('second_person_approval as p', 'p.id', 'a.approval_id')
      .selectAll('a')
      .select(['s.revoked_at as assignment_revoked_at', 's.valid_until as assignment_valid_until', 'p.status as approval_status', 'p.request_expires_at as approval_request_expires_at', 'p.approved_by as approved_by'])
      .where((eb) => eb.or([eb('a.hub_id', '=', hubId), eb('a.scope_kind', 'in', ['node', 'platform'])]));
    if (personId) query = query.where('a.person_id', '=', personId);
    return query.orderBy('a.created_at', 'desc').limit(500).execute() as Promise<StaffActivationJoinedRow[]>;
  },
  async activation(trx: Transaction, activationId: string): Promise<StaffActivationJoinedRow | undefined> {
    const rows = await trx.selectFrom('staff_activation as a')
      .leftJoin('staff_role_assignment as s', 's.id', 'a.assignment_id')
      .leftJoin('second_person_approval as p', 'p.id', 'a.approval_id')
      .selectAll('a')
      .select(['s.revoked_at as assignment_revoked_at', 's.valid_until as assignment_valid_until', 'p.status as approval_status', 'p.request_expires_at as approval_request_expires_at', 'p.approved_by as approved_by'])
      .where('a.id', '=', activationId).execute() as StaffActivationJoinedRow[];
    return rows[0];
  },
};
