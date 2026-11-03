import { sql } from 'kysely';
import type { z } from 'zod';
import { SENSITIVE_HUB_STAFF_ROLES, type ConsolePermission, type HubStaffRole, type StaffScope } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { approverAllowed, effectiveGrants, rolesGranting, sodEvaluation } from '../authority.js';
import { staffAssignments, staffRoleDefinitions, type StaffRoleAssignmentRow } from '../deps.js';
import { adminRefusal } from '../errors.js';
import { toDefs, toFacts, type Elevated, type PlatformAdminService } from '../platform-admin.service.js';
import type { PlainCommandSchema } from '../schemas.js';
import { scopeOf, toAssignment } from '../views.js';
import {
  staffLifecycle, type DecideActivationCommandSchema, type EffectiveAccess, type GrantEligibleRoleCommandSchema, type InviteStaffCommandSchema, type MyStaffInvitation,
  type MyStaffInvitationRow, type RequestActivationCommandSchema, type RoleChangeApplyCommandSchema, type RoleChangePreview, type RoleChangePreviewRequestSchema,
  type StaffActivationJoinedRow, type StaffActivationView, type StaffDirectory, type StaffDirectoryRow, type StaffEligibleRoleRow, type StaffEligibleRoleView,
  type StaffInvitationRow, type StaffInvitationView,
} from './deps.js';
import { previewRoleChange, RoleChangeError } from './role-change.js';

/** An ISO timestamp in the contract's form (UTC, `Z`), whatever form PostgreSQL's JSON gave it. */
const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

const toEntry = (r: StaffDirectoryRow): StaffDirectory['entries'][number] => ({
  personId: r.person_id,
  displayName: r.display_name,
  roles: r.roles === null ? null : r.roles.map((x) => ({ assignmentId: x.assignmentId, role: x.role as HubStaffRole, scope: x.scope, validUntil: iso(x.validUntil), breakglass: x.breakglass })),
  secondFactor: r.second_factor,
});

const isoOf = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());
const seconds = (value: string | number | null): number | null => (value === null ? null : Number(value));

/** An invitation for staff who manage its scope (the address included). */
export const toInvitation = (r: StaffInvitationRow, now: Date): StaffInvitationView => ({
  id: r.id, email: r.email_normalized, role: r.role as HubStaffRole, scope: scopeOf(r) as StaffScope, definitionVersion: r.definition_version,
  validForSeconds: seconds(r.valid_for_seconds), sensitive: r.sensitive, status: r.status,
  expired: (r.status === 'pending' || r.status === 'accepted') && new Date(r.expires_at).getTime() <= now.getTime(), personId: r.person_id, invitedBy: r.invited_by,
  reason: r.reason, expiresAt: isoOf(r.expires_at)!, respondedAt: isoOf(r.responded_at), approvalId: r.approval_id, assignmentId: r.assignment_id, revision: r.revision,
});
const toMine = (r: MyStaffInvitationRow): MyStaffInvitation => ({
  id: r.id, role: r.role as HubStaffRole, scope: scopeOf(r) as StaffScope, validForSeconds: seconds(r.valid_for_seconds), reason: r.reason, inviterName: r.inviter_name,
  expiresAt: isoOf(r.expires_at)!,
});
const sensitive = (role: string): boolean => SENSITIVE_HUB_STAFF_ROLES.includes(role as HubStaffRole);
const ended = (at: Date | string | null, now: Date): boolean => at !== null && new Date(at).getTime() <= now.getTime();

export const toEligibleRole = (r: StaffEligibleRoleRow, now: Date): StaffEligibleRoleView => ({
  id: r.id, personId: r.person_id, role: r.role as HubStaffRole, scope: scopeOf(r) as StaffScope, definitionVersion: r.definition_version, maxActivationSeconds: Number(r.max_activation_seconds),
  sensitive: sensitive(r.role), grantedBy: r.granted_by, reason: r.reason, validFrom: isoOf(r.valid_from)!, validUntil: isoOf(r.valid_until), revokedAt: isoOf(r.revoked_at), revokedBy: r.revoked_by,
  open: r.revoked_at === null && new Date(r.valid_from).getTime() <= now.getTime() && !ended(r.valid_until, now), revision: r.revision,
});
/** The state of an activation now: from its row, its approval (while pending) and its assignment (once active). */
export function activationState(r: StaffActivationJoinedRow, now: Date): StaffActivationView['state'] {
  if (r.status === 'declined' || r.status === 'withdrawn') return r.status;
  if (r.status === 'pending') {
    if (r.approval_status === 'declined') return 'declined';
    if (r.approval_status === 'revoked') return 'withdrawn';
    return ended(r.approval_request_expires_at, now) ? 'expired' : 'pending';
  }
  return r.assignment_revoked_at !== null || ended(r.assignment_valid_until ?? r.active_until, now) ? 'ended' : 'active';
}
export const toActivation = (r: StaffActivationJoinedRow, now: Date): StaffActivationView => ({
  id: r.id, eligibleRoleId: r.eligible_role_id, personId: r.person_id, role: r.role as HubStaffRole, scope: scopeOf(r) as StaffScope, windowSeconds: Number(r.window_seconds),
  sensitive: r.sensitive, reason: r.reason, state: activationState(r, now), approvalId: r.approval_id, approvedBy: r.approved_by, decidedBy: r.decided_by, assignmentId: r.assignment_id,
  activeFrom: isoOf(r.active_from), activeUntil: isoOf(r.active_until), requestedAt: isoOf(r.created_at)!, revision: r.revision,
});

/**
 * ADM-004 reads of the staff of a hub. Each runs as the requesting person; the database decides who may read what
 * (`staff_directory`, `staff_effective_assignments`) and answers "not found" to anyone who is not staff of the hub.
 */
export class StaffLifecycleService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService, private readonly admin: PlatformAdminService) {}

  private read<T>(state: RequestState, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, (trx) => fn(trx)).catch((error: unknown) => {
      throw adminRefusal(error) ?? error;
    });
  }

  directory(state: RequestState, hubId: string): Promise<StaffDirectory> {
    return this.read(state, async (trx) => {
      const rows = await staffLifecycle.directory(trx, hubId);
      return { hubId, detail: rows[0]?.detail ?? false, entries: rows.map(toEntry) };
    });
  }

  /* ---------- Part 2: invitations ---------- */

  invitations(state: RequestState, hubId: string): Promise<{ invitations: StaffInvitationView[] }> {
    return this.read(state, async (trx) => ({ invitations: (await staffLifecycle.invitations(trx, hubId)).map((r) => toInvitation(r, this.ctx.clock.now())) }));
  }

  invite(e: Elevated, body: z.infer<typeof InviteStaffCommandSchema>) {
    const attempt = { target: body.scope, permission: 'admin.staff.assign' as const, action: 'staff.invited', objectType: 'staff_invitation', objectId: body.scope.kind === 'hub' ? body.scope.hubId : body.scope.kind === 'node' ? body.scope.nodeId : '00000000-0000-0000-0000-000000000000' };
    return this.admin.staffCommand(e, body, attempt, async (trx, _p, cmd) => ({
      invitation: toInvitation(await staffLifecycle.invite(trx, cmd, { email: body.email, role: body.role, scope: body.scope, definitionVersion: body.definitionVersion, validForSeconds: body.validForSeconds }), this.ctx.clock.now()),
    }));
  }

  apply(e: Elevated, invitationId: string, body: z.infer<typeof PlainCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => {
      const { invitation, outcome } = await staffLifecycle.apply(trx, cmd, invitationId);
      return { result: { outcome }, invitation: toInvitation(invitation, this.ctx.clock.now()) };
    });
  }

  withdraw(e: Elevated, invitationId: string, body: z.infer<typeof PlainCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => ({ invitation: toInvitation(await staffLifecycle.withdraw(trx, cmd, invitationId), this.ctx.clock.now()) }));
  }

  /** The signed-in person's own open invitations (by verified address); anyone may ask, and sees only their own. */
  mine(state: RequestState): Promise<{ invitations: MyStaffInvitation[] }> {
    return this.read(state, async (trx) => ({ invitations: (await staffLifecycle.mine(trx)).map(toMine) }));
  }

  respond(state: RequestState, invitationId: string, accept: boolean): Promise<{ status: string }> {
    return this.read(state, async (trx) => ({ status: (await staffLifecycle.respond(trx, invitationId, accept)).status }));
  }

  /* ---------- Part 3: eligible roles and just-in-time activation ---------- */

  eligibleRoles(state: RequestState, hubId: string, personId?: string): Promise<{ eligibleRoles: StaffEligibleRoleView[] }> {
    return this.read(state, async (trx) => ({ eligibleRoles: (await staffLifecycle.eligibleRoles(trx, hubId, personId)).map((r) => toEligibleRole(r, this.ctx.clock.now())) }));
  }

  grantEligible(e: Elevated, body: z.infer<typeof GrantEligibleRoleCommandSchema>) {
    const attempt = { target: body.scope, permission: 'admin.staff.assign' as const, action: 'staff.grant_eligible_role', objectType: 'staff_eligible_role', objectId: body.personId };
    return this.admin.staffCommand(e, body, attempt, async (trx, _p, cmd) => ({
      eligibleRole: toEligibleRole(await staffLifecycle.grantEligible(trx, cmd, {
        personId: body.personId, role: body.role, scope: body.scope, definitionVersion: body.definitionVersion, maxActivationSeconds: body.maxActivationSeconds, validForSeconds: body.validForSeconds,
      }), this.ctx.clock.now()),
    }));
  }

  revokeEligible(e: Elevated, eligibleRoleId: string, body: z.infer<typeof PlainCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => ({ eligibleRole: toEligibleRole(await staffLifecycle.revokeEligible(trx, cmd, eligibleRoleId), this.ctx.clock.now()) }));
  }

  activations(state: RequestState, hubId: string, personId?: string): Promise<{ activations: StaffActivationView[] }> {
    return this.read(state, async (trx) => ({ activations: (await staffLifecycle.activations(trx, hubId, personId)).map((r) => toActivation(r, this.ctx.clock.now())) }));
  }

  private async activationView(trx: Transaction, id: string): Promise<StaffActivationView> {
    const row = await staffLifecycle.activation(trx, id);
    if (!row) throw new ApiError('access.not_found', 'activation not found');
    return toActivation(row, this.ctx.clock.now());
  }

  /** The eligible person activates a role; the database checks the fresh second factor, the ceiling and the conflicts. */
  requestActivation(e: Elevated, body: z.infer<typeof RequestActivationCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => {
      const { activation, outcome } = await staffLifecycle.requestActivation(trx, cmd, body.eligibleRoleId, body.windowSeconds);
      return { result: { outcome }, activation: await this.activationView(trx, activation.id) };
    });
  }

  /**
   * The second person decides. In full separation-of-duties mode the approver acts through a role the eligibility's
   * grantor (the requester in ADM-001's terms) does not hold for `admin.staff.assign`, as the approvals inbox requires.
   */
  decideActivation(e: Elevated, activationId: string, body: z.infer<typeof DecideActivationCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, p, cmd) => {
      const before = await staffLifecycle.activation(trx, activationId);
      if (before && body.decision === 'approve') {
        const target = scopeOf(before);
        const [grantor, rows, defs] = await Promise.all([
          trx.selectFrom('staff_eligible_role').select('granted_by').where('id', '=', before.eligible_role_id).executeTakeFirst(),
          staffAssignments.list(trx, { activeOnly: true }), staffRoleDefinitions.list(trx),
        ]);
        if (grantor && (await staffAssignments.hasPermission(trx, 'admin.staff.read', target))) {
          const facts = toFacts(rows);
          const definitions = toDefs(defs);
          const now = this.ctx.clock.now();
          const verdict = approverAllowed({
            mode: sodEvaluation(facts, definitions, target, now).mode, requesterId: grantor.granted_by, approverId: p.personId,
            requesterRoles: rolesGranting(facts, definitions, grantor.granted_by, ['admin.staff.assign'], target, now), approverRoles: rolesGranting(facts, definitions, p.personId, ['admin.staff.assign'], target, now),
          });
          if (!verdict.ok && verdict.reason === 'same_role') throw new ApiError('access.second_approver_required', 'in full separation-of-duties mode the second person acts through a different role', { reason: 'same_role', sodMode: 'full' });
        }
      }
      const row = await staffLifecycle.decideActivation(trx, cmd, activationId, body.decision);
      return { activation: await this.activationView(trx, row.id) };
    });
  }

  endActivation(e: Elevated, activationId: string, body: z.infer<typeof PlainCommandSchema>) {
    return this.admin.staffCommand(e, body, null, async (trx, _p, cmd) => {
      const row = await staffLifecycle.endActivation(trx, cmd, activationId);
      return { activation: await this.activationView(trx, row.id) };
    });
  }

  /* ---------- Part 3: role change with preview ---------- */

  private async roleChangePreview(trx: Transaction, request: z.infer<typeof RoleChangePreviewRequestSchema>): Promise<RoleChangePreview> {
    const [canRead, canAssign] = await Promise.all([staffAssignments.hasPermission(trx, 'admin.staff.read', request.scope), staffAssignments.hasPermission(trx, 'admin.staff.assign', request.scope)]);
    if (!canRead || !canAssign) throw new ApiError('access.forbidden', 'admin.staff.read and admin.staff.assign are required at this scope', { required: 'permission' });
    const [person, all, defs] = await Promise.all([
      staffAssignments.list(trx, { personId: request.personId }), staffAssignments.list(trx, { activeOnly: true }), staffRoleDefinitions.list(trx),
    ]);
    try {
      return previewRoleChange(request, person, all, defs, SENSITIVE_HUB_STAFF_ROLES, this.ctx.clock.now());
    } catch (error) {
      if (error instanceof RoleChangeError) throw new ApiError('validation.schema', error.message, { reason: error.reason });
      throw error;
    }
  }

  /** The difference a role change would make, never stored; `apply` recomputes it. */
  previewRoleChange(state: RequestState, request: z.infer<typeof RoleChangePreviewRequestSchema>): Promise<{ preview: RoleChangePreview }> {
    return this.read(state, async (trx) => ({ preview: await this.roleChangePreview(trx, request) }));
  }

  /**
   * Applies a previewed role change in one transaction: the person's role changes serialize on an advisory lock, the
   * preview is recomputed from the rows as they are now and refused when its digest differs, a blocking conflict is
   * refused before anything changes, then each removal and addition runs through the ADM-001 commands (which audit,
   * check the second person and the separation of duties themselves).
   */
  applyRoleChange(e: Elevated, body: z.infer<typeof RoleChangeApplyCommandSchema>) {
    const attempt = { target: body.scope, permission: 'admin.staff.assign' as const, action: 'staff.role_change', objectType: 'staff_role_assignment', objectId: body.personId };
    return this.admin.staffCommand(e, body, attempt, async (trx, _p, cmd) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`staff_role_change:${body.personId}`}))`.execute(trx);
      const preview = await this.roleChangePreview(trx, body);
      if (preview.previewDigest !== body.previewDigest) throw new ApiError('validation.revision_conflict', 'the roles changed since the preview; review the new difference', { reason: 'preview_stale' });
      const blocking = preview.sod.conflicts.filter((c) => c.blocking);
      if (blocking.length) throw new ApiError('validation.schema', `${blocking[0]!.role} conflicts with ${blocking[0]!.conflictsWith}`, { reason: 'sod_conflict', conflicts: blocking });
      for (const needed of preview.approvals) {
        if (!body.approvals.some((a) => a.role === needed.role)) throw new ApiError('access.approval_required', `${needed.role} needs a second person`, { reason: 'approval_required', role: needed.role, actionDigest: needed.actionDigest });
      }
      const revoked: StaffRoleAssignmentRow[] = [];
      for (const id of body.remove) revoked.push(await staffAssignments.revoke(trx, cmd, id));
      const assigned: StaffRoleAssignmentRow[] = [];
      for (const add of body.add) {
        const approvalId = body.approvals.find((a) => a.role === add.role)?.approvalId ?? null;
        assigned.push(await staffAssignments.assign(trx, cmd, { personId: body.personId, role: add.role, scope: body.scope, definitionVersion: add.definitionVersion, validForSeconds: add.validForSeconds, approvalId }));
      }
      return { preview, revoked: revoked.map(toAssignment), assigned: assigned.map(toAssignment) };
    });
  }

  effectiveAccess(state: RequestState, hubId: string, personId: string): Promise<EffectiveAccess> {
    return this.read(state, async (trx) => {
      const [rows, defs] = await Promise.all([staffLifecycle.effectiveAssignments(trx, hubId, personId), staffRoleDefinitions.list(trx)]);
      const grants = effectiveGrants(toFacts(rows), toDefs(defs), personId, { kind: 'hub', hubId }, this.ctx.clock.now());
      return { personId, hubId, roles: grants.roles, permissions: grants.permissions as ConsolePermission[], breakglassOnly: grants.breakglassOnly as ConsolePermission[] };
    });
  }
}
