import type { z } from 'zod';
import type { ConsolePermission, HubStaffRole, StaffScope } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { effectiveGrants } from '../authority.js';
import { staffRoleDefinitions } from '../deps.js';
import { adminRefusal } from '../errors.js';
import { toDefs, toFacts, type Elevated, type PlatformAdminService } from '../platform-admin.service.js';
import type { PlainCommandSchema } from '../schemas.js';
import { scopeOf } from '../views.js';
import {
  staffLifecycle, type EffectiveAccess, type InviteStaffCommandSchema, type MyStaffInvitation, type MyStaffInvitationRow, type StaffDirectory, type StaffDirectoryRow,
  type StaffInvitationRow, type StaffInvitationView,
} from './deps.js';

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

  effectiveAccess(state: RequestState, hubId: string, personId: string): Promise<EffectiveAccess> {
    return this.read(state, async (trx) => {
      const [rows, defs] = await Promise.all([staffLifecycle.effectiveAssignments(trx, hubId, personId), staffRoleDefinitions.list(trx)]);
      const grants = effectiveGrants(toFacts(rows), toDefs(defs), personId, { kind: 'hub', hubId }, this.ctx.clock.now());
      return { personId, hubId, roles: grants.roles, permissions: grants.permissions as ConsolePermission[], breakglassOnly: grants.breakglassOnly as ConsolePermission[] };
    });
  }
}
