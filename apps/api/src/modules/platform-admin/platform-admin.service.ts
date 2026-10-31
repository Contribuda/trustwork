import { sql } from 'kysely';
import type { z } from 'zod';
import type { ConsolePermission, HubStaffRole, Principal, StaffScope } from '../../deps/contracts.js';
import { outbox, withPrincipal, type Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import {
  approverAllowed, effectiveGrants, rolesGranting, sodEvaluation, type AssignmentFact, type DefinitionFact, type SodEvaluation, type StaffTarget,
} from './authority.js';
import {
  adminAudit, adminDigests, adminSetup, appeals, approvals, caseGrants, featureFlags, incidents, moderation, staffAssignments, staffConflicts, staffRoleDefinitions,
  type CommandContext, type ModerationDecision, type SecondPersonApprovalRow, type StaffRoleAssignmentRow, type StaffRoleDefinitionRow,
} from './deps.js';
import { adminRefusal, isAuthorityRefusal } from './errors.js';
import type { ModerationTargetPort, SanctionEnforcementPort } from './ports.js';
import type {
  ApplySanctionCommandSchema, ApprovalSubject, ApproveCommandSchema, AssignRoleCommandSchema, AuditQuerySchema, BreakglassCommandSchema, DecideAppealCommandSchema,
  DecideCaseGrantCommandSchema, DecideModerationCaseCommandSchema, DeclareConflictCommandSchema, FileAppealCommandSchema, OpenIncidentCommandSchema, OpenModerationCaseCommandSchema,
  PlainCommandSchema, ReportContentCommandSchema, RequestApprovalCommandSchema, RequestCaseGrantCommandSchema, SetFlagCommandSchema,
} from './schemas.js';
import {
  scopeOf, toAccessLogEntry, toAppeal, toApproval, toAssignment, toAuditEvent, toCaseGrant, toConflict, toDefinition, toFlag, toIncident, toModerationCase, toOwnReport, toReport, toSanction,
} from './views.js';

type Cmd = z.infer<typeof PlainCommandSchema>;
interface Elevated { state: RequestState; elevationId: string; idempotencyKey: string | undefined }
interface Attempt { target: StaffTarget; permission: ConsolePermission; action: string; objectType: string; objectId: string }

const SEVENTY_TWO_HOURS = 72 * 3600;
const toFacts = (rows: StaffRoleAssignmentRow[]): AssignmentFact[] => rows.map((r) => ({
  personId: r.person_id, role: r.role as HubStaffRole, scope: scopeOf(r), definitionVersion: r.definition_version, breakglass: r.breakglass,
  validFrom: new Date(r.valid_from), validUntil: r.valid_until ? new Date(r.valid_until) : null, revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
}));
const toDefs = (rows: StaffRoleDefinitionRow[]): DefinitionFact[] => rows.map((r) => ({
  role: r.role as HubStaffRole, version: r.version, scopes: r.scopes, permissions: r.permissions as ConsolePermission[], sodMode: r.sod_mode, sodConflicts: r.sod_conflicts as HubStaffRole[],
  grantMaxHours: r.grant_max_hours,
}));
/** The target a query names: a hub, the node, or (neither) the platform. */
export const targetFrom = (q: { nodeId?: string | undefined; hubId?: string | undefined }): StaffTarget => (q.hubId ? { kind: 'hub', hubId: q.hubId } : q.nodeId ? { kind: 'node', nodeId: q.nodeId } : { kind: 'platform' });
const decisionEffect = (d: ModerationDecision): 'remove' | 'restore' | 'none' => (d === 'content_removed' ? 'remove' : d === 'content_restored' ? 'restore' : 'none');

/**
 * Platform administration use cases (ADM-001): staff authority, separation of duties, second-person approvals bound to
 * an action digest, case access grants (never impersonation), audit queries, moderation with the sanction ladder and
 * appeals, feature flags and incidents.
 *
 * Every staff command runs in one `PrincipalService.runAs` transaction as the staff member, through the DATA-002
 * SECURITY DEFINER commands, with a `CommandContext` naming the live elevation the route guard verified, the request id
 * and the staff reason; the database checks permission, scope, conflicts of interest and the second-person rules, and
 * writes the audit row in that same transaction (BE-005: the idempotency record completes there too). A refusal of
 * authority is recorded as a `denied` audit row in its own transaction. Effects on other modules go through ports
 * (`ports.ts`) in the same transaction; notices are outbox intents (MAIL-001 delivers them).
 */
export class PlatformAdminService {
  constructor(
    private readonly ctx: AppContext,
    private readonly principals: PrincipalService,
    private readonly moderationTargets: ModerationTargetPort,
    private readonly sanctions: SanctionEnforcementPort,
  ) {}

  private get now(): Date {
    return this.ctx.clock.now();
  }

  /* ---------- Plumbing ---------- */

  private commandContext(e: Elevated, body: Cmd): CommandContext {
    if (e.idempotencyKey !== undefined && body.idempotencyKey !== e.idempotencyKey) throw new ApiError('validation.schema', 'idempotencyKey must equal the Idempotency-Key header', { reason: 'idempotency_key_mismatch' });
    return { elevationId: e.elevationId, requestId: e.state.requestId, reasonCode: body.reasonCode ?? 'console_action', reasonText: body.reason };
  }

  /**
   * One staff command: the request transaction as the staff member; database refusals become contract errors, and a
   * refusal of authority leaves a `denied` audit row (own transaction, so it survives the rollback).
   */
  private async staff<T>(e: Elevated, body: Cmd, attempt: Attempt | null, fn: (trx: Transaction, p: Principal, cmd: CommandContext) => Promise<T>): Promise<T> {
    const cmd = this.commandContext(e, body);
    try {
      return await this.principals.runAs(e.state, (trx, p) => fn(trx, p, cmd));
    } catch (error) {
      const refusal = error instanceof ApiError ? error : adminRefusal(error);
      if (refusal && attempt && isAuthorityRefusal(refusal)) await this.recordDenied(e, cmd, attempt, refusal).catch((failure: unknown) => this.ctx.log('admin.denied_audit_failed', failure));
      throw refusal ?? error;
    }
  }

  /** Reads as the staff member (row-level security decides what is visible). */
  private read<T>(state: RequestState, fn: (trx: Transaction, p: Principal) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, fn).catch((error: unknown) => {
      throw adminRefusal(error) ?? error;
    });
  }

  private async facts(trx: Transaction, personId?: string): Promise<{ assignments: AssignmentFact[]; defs: DefinitionFact[] }> {
    const [rows, defs] = await Promise.all([staffAssignments.list(trx, { activeOnly: true, ...(personId ? { personId } : {}) }), staffRoleDefinitions.list(trx)]);
    return { assignments: toFacts(rows), defs: toDefs(defs) };
  }

  /** A role of the caller covering the target (preferring one that grants `permission`), for audit rows the commands do not write. */
  private async ownRoleAt(trx: Transaction, personId: string, target: StaffTarget, permission: ConsolePermission): Promise<HubStaffRole | null> {
    const { assignments, defs } = await this.facts(trx, personId);
    const granting = rolesGranting(assignments, defs, personId, [permission], target, this.now);
    return granting[0] ?? effectiveGrants(assignments, defs, personId, target, this.now).roles[0] ?? null;
  }

  private async recordDenied(e: Elevated, cmd: CommandContext, attempt: Attempt, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const role = await this.ownRoleAt(trx, p.personId, attempt.target, attempt.permission);
      if (!role) return; // no staff role covers the target: nothing this person may be audited as there
      const reason = typeof refusal.details?.reason === 'string' ? refusal.details.reason : refusal.code.replace(/\W/g, '_');
      await adminAudit.append(trx, {
        actorPersonId: p.personId, actorRole: role, scope: attempt.target, permission: attempt.permission, elevationId: cmd.elevationId, action: attempt.action,
        objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: `denied_${reason}`.slice(0, 64), reasonText: cmd.reasonText, outcome: 'denied', requestId: cmd.requestId,
      });
    });
  }

  /** An applied audit row for the few staff mutations whose database command does not record itself. */
  private async recordApplied(trx: Transaction, p: Principal, cmd: CommandContext, attempt: Attempt): Promise<void> {
    const role = await this.ownRoleAt(trx, p.personId, attempt.target, attempt.permission);
    if (!role) throw new ApiError('access.forbidden', 'no staff role covers this scope', { required: 'staff' });
    await adminAudit.append(trx, {
      actorPersonId: p.personId, actorRole: role, scope: attempt.target, permission: attempt.permission, elevationId: cmd.elevationId, action: attempt.action,
      objectType: attempt.objectType, objectId: attempt.objectId, reasonCode: cmd.reasonCode, reasonText: cmd.reasonText, outcome: 'applied', requestId: cmd.requestId,
    });
  }

  private caseRow(trx: Transaction, id: string) {
    return trx.selectFrom('moderation_case').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** The permissions that execute (and therefore request and approve) a second-person action, from the database vocabulary. */
  private async actionPermissions(trx: Transaction, action: string): Promise<ConsolePermission[]> {
    const { rows } = await sql<{ permissions: string[] | null }>`SELECT trustwork.admin_action_permissions(${action}) AS permissions`.execute(trx);
    return (rows[0]?.permissions ?? []) as ConsolePermission[];
  }

  private async notice(trx: Transaction, aggregate: { kind: string; id: string }, type: string, payload: Record<string, unknown>): Promise<void> {
    await outbox.append(trx, { aggregate_kind: aggregate.kind, aggregate_id: aggregate.id, revision: 1, type, payload });
  }

  /* ---------- Node, own access, separation of duties ---------- */

  node(state: RequestState) {
    return this.read(state, async (trx) => {
      const node = await adminSetup.node(trx);
      if (!node) throw new ApiError('access.not_found', 'no node is set up');
      return { nodeId: node.id, label: node.label };
    });
  }

  /** The viewer's materialised grants at a target (what the console shows and hides). */
  access(state: RequestState, target: StaffTarget) {
    return this.read(state, async (trx, p) => {
      const { assignments, defs } = await this.facts(trx, p.personId);
      return { personId: p.personId, target, ...effectiveGrants(assignments, defs, p.personId, target, this.now) };
    });
  }

  /** Separation-of-duties mode of a target; needs `admin.staff.read` there (the count covers people the caller may see). */
  sod(state: RequestState, target: StaffTarget) {
    return this.read(state, async (trx) => {
      if (!(await staffAssignments.hasPermission(trx, 'admin.staff.read', target))) throw new ApiError('access.forbidden', 'admin.staff.read is required at this scope', { required: 'permission' });
      const { assignments, defs } = await this.facts(trx);
      return { target, ...sodEvaluation(assignments, defs, target, this.now) };
    });
  }

  /**
   * The full-mode check of a second-person decision, evaluated on the staff directory the approver may read. Without
   * `admin.staff.read` at the scope the directory is not visible and only the database rules apply (different person,
   * permission at the scope, digest, expiry); the response says so (`verified: false`).
   */
  private async sodForDecision(trx: Transaction, approverId: string, approval: SecondPersonApprovalRow): Promise<{ verified: boolean; evaluation: SodEvaluation | null; requesterRoles: HubStaffRole[]; approverRoles: HubStaffRole[] }> {
    const target = scopeOf(approval);
    if (!(await staffAssignments.hasPermission(trx, 'admin.staff.read', target))) return { verified: false, evaluation: null, requesterRoles: [], approverRoles: [] };
    const permissions = await this.actionPermissions(trx, approval.action);
    const { assignments, defs } = await this.facts(trx);
    const evaluation = sodEvaluation(assignments, defs, target, this.now);
    return {
      verified: true, evaluation,
      requesterRoles: rolesGranting(assignments, defs, approval.requested_by, permissions, target, this.now),
      approverRoles: rolesGranting(assignments, defs, approverId, permissions, target, this.now),
    };
  }

  /* ---------- Staff ---------- */

  definitions(state: RequestState) {
    return this.read(state, async (trx) => ({ definitions: (await staffRoleDefinitions.list(trx)).map(toDefinition) }));
  }

  assignments(state: RequestState, filter: { personId?: string | undefined; activeOnly?: boolean }) {
    return this.read(state, async (trx) => ({
      assignments: (await staffAssignments.list(trx, { ...(filter.personId ? { personId: filter.personId } : {}), activeOnly: filter.activeOnly ?? false })).map(toAssignment),
    }));
  }

  assign(e: Elevated, body: z.infer<typeof AssignRoleCommandSchema>) {
    const attempt: Attempt = { target: body.scope, permission: 'admin.staff.assign', action: 'staff.assign_role', objectType: 'staff_role_assignment', objectId: body.personId };
    return this.staff(e, body, attempt, async (trx, p, cmd) => {
      const row = await staffAssignments.assign(trx, cmd, {
        personId: body.personId, role: body.role, scope: body.scope, definitionVersion: body.definitionVersion, validForSeconds: body.validForSeconds ?? null, approvalId: body.approvalId ?? null,
      });
      await this.notice(trx, { kind: 'person', id: body.personId }, 'admin.staff_role_assigned', { assignmentId: row.id, role: row.role, scopeKind: row.scope_kind, grantedBy: p.personId });
      return { assignment: toAssignment(row) };
    });
  }

  breakglass(e: Elevated, body: z.infer<typeof BreakglassCommandSchema>) {
    const attempt: Attempt = { target: body.scope, permission: 'admin.staff.breakglass', action: 'staff.grant_breakglass', objectType: 'staff_role_assignment', objectId: body.personId };
    return this.staff(e, body, attempt, async (trx, p, cmd) => {
      const row = await staffAssignments.assign(trx, cmd, {
        personId: body.personId, role: body.role, scope: body.scope, definitionVersion: body.definitionVersion, validForSeconds: body.validForSeconds, breakglass: true,
        incidentId: body.incidentId, approvalId: body.approvalId,
      });
      await this.notice(trx, { kind: 'person', id: body.personId }, 'admin.breakglass_granted', { assignmentId: row.id, role: row.role, incidentId: body.incidentId, grantedBy: p.personId, validUntil: row.valid_until });
      return { assignment: toAssignment(row) };
    });
  }

  revoke(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      const row = await staffAssignments.revoke(trx, cmd, id);
      await this.notice(trx, { kind: 'person', id: row.person_id }, 'admin.staff_role_revoked', { assignmentId: row.id, role: row.role });
      return { assignment: toAssignment(row) };
    });
  }

  conflicts(state: RequestState) {
    return this.read(state, async (trx) => ({ conflicts: (await trx.selectFrom('staff_conflict_declaration').selectAll().orderBy('declared_at').execute()).map(toConflict) }));
  }

  declareConflict(e: Elevated, body: z.infer<typeof DeclareConflictCommandSchema>) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const row = await staffConflicts.declare(trx, body.party, cmd.reasonText);
      // Declaring narrows what the person may do; it is audited at the scope of one of their own active roles.
      const held = (await this.facts(trx, p.personId)).assignments.find((a) => a.personId === p.personId);
      if (!held) throw new ApiError('access.forbidden', 'staff only', { required: 'staff' });
      await this.recordApplied(trx, p, cmd, { target: held.scope, permission: 'admin.staff.conflict.declare', action: 'staff.declare_conflict', objectType: 'staff_conflict_declaration', objectId: row.id });
      return { conflict: toConflict(row) };
    });
  }

  endConflict(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, _p, cmd) => ({ conflict: toConflict(await staffConflicts.end(trx, cmd, id)) }));
  }

  /* ---------- Incidents (break-glass names one) ---------- */

  openIncident(e: Elevated, body: z.infer<typeof OpenIncidentCommandSchema>) {
    return this.staff(e, body, null, async (trx, _p, cmd) => ({
      incident: toIncident(await incidents.open(trx, cmd, { scope: body.scope, kind: body.kind, severity: body.severity, title: body.title })),
    }));
  }

  incidents(state: RequestState) {
    return this.read(state, async (trx) => ({ incidents: (await trx.selectFrom('incident').selectAll().orderBy('opened_at', 'desc').limit(200).execute()).map(toIncident) }));
  }

  /* ---------- Second-person approvals ---------- */

  /** The digest and scope a described action binds (computed here, recomputed by the database at execution). */
  private async bind(trx: Transaction, subject: ApprovalSubject): Promise<{ scope: StaffScope; digest: string }> {
    switch (subject.action) {
      case 'staff.assign_sensitive_role':
        return { scope: subject.scope, digest: adminDigests.assignment({ breakglass: false, personId: subject.personId, role: subject.role, scope: subject.scope, definitionVersion: subject.definitionVersion, validForSeconds: subject.validForSeconds ?? null }) };
      case 'staff.grant_breakglass':
        return {
          scope: subject.scope,
          digest: adminDigests.assignment({ breakglass: true, personId: subject.personId, role: subject.role, scope: subject.scope, definitionVersion: subject.definitionVersion, incidentId: subject.incidentId, validForSeconds: subject.validForSeconds }),
        };
      case 'moderation.apply_sanction_l4': {
        const c = await this.caseRow(trx, subject.moderationCaseId);
        if (!c) throw new ApiError('access.not_found', 'moderation case not found');
        const party = c.subject_person_id ? { kind: 'person' as const, id: c.subject_person_id } : c.subject_company_id ? { kind: 'company' as const, id: c.subject_company_id } : null;
        if (!party) throw new ApiError('validation.schema', 'the case names no subject', { reason: 'case_mismatch' });
        return { scope: { kind: 'hub', hubId: c.hub_id }, digest: adminDigests.sanction({ moderationCaseId: c.id, subject: party, level: 4, featureScope: subject.featureScope, durationSeconds: subject.durationSeconds }) };
      }
      default:
        return { scope: subject.scope, digest: subject.actionDigest };
    }
  }

  requestApproval(e: Elevated, body: z.infer<typeof RequestApprovalCommandSchema>) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const { scope, digest } = await this.bind(trx, body.subject);
      const row = await approvals.request(trx, cmd, { action: body.subject.action, scope, actionDigest: digest });
      await this.notice(trx, { kind: 'second_person_approval', id: row.id }, 'admin.approval_requested', { action: row.action, scopeKind: row.scope_kind, hubId: row.hub_id, requestedBy: p.personId });
      return { approval: toApproval(row) };
    });
  }

  approvalsFor(state: RequestState, filter: { hubId?: string | undefined }) {
    return this.read(state, async (trx, p) => {
      let query = trx.selectFrom('second_person_approval').selectAll();
      if (filter.hubId) query = query.where('hub_id', '=', filter.hubId);
      const rows = await query.orderBy('requested_at', 'desc').limit(500).execute();
      const now = this.now.getTime();
      return {
        forMe: rows.filter((r) => r.status === 'pending' && r.requested_by !== p.personId && new Date(r.request_expires_at).getTime() > now).map(toApproval),
        mine: rows.filter((r) => r.requested_by === p.personId).map(toApproval),
        decided: rows.filter((r) => r.status !== 'pending' && r.requested_by !== p.personId).slice(0, 100).map(toApproval),
      };
    });
  }

  approval(state: RequestState, id: string) {
    return this.read(state, async (trx) => {
      const row = await approvals.get(trx, id);
      if (!row) throw new ApiError('access.not_found', 'approval not found');
      return { approval: toApproval(row) };
    });
  }

  approve(e: Elevated, id: string, body: z.infer<typeof ApproveCommandSchema>) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const before = await approvals.get(trx, id);
      if (!before) throw new ApiError('access.not_found', 'approval not found');
      const sod = await this.sodForDecision(trx, p.personId, before);
      if (sod.verified && sod.evaluation) {
        const verdict = approverAllowed({ mode: sod.evaluation.mode, requesterId: before.requested_by, approverId: p.personId, requesterRoles: sod.requesterRoles, approverRoles: sod.approverRoles });
        if (!verdict.ok && verdict.reason === 'same_role') throw new ApiError('access.second_approver_required', 'in full separation-of-duties mode the second person acts through a different role', { reason: 'same_role', sodMode: 'full' });
      }
      const row = await approvals.decide(trx, cmd, id, 'approve', body.actionDigest, body.validForSeconds ?? SEVENTY_TWO_HOURS);
      await this.notice(trx, { kind: 'person', id: row.requested_by }, 'admin.approval_decided', { approvalId: row.id, action: row.action, decision: 'approve' });
      return { approval: toApproval(row), sod: { verified: sod.verified, mode: sod.evaluation?.mode ?? null, staffCount: sod.evaluation?.staffCount ?? null } };
    }).catch(async (error: unknown) => {
      if (error instanceof ApiError && isAuthorityRefusal(error)) await this.recordApprovalDenied(e, body, id, error);
      throw error;
    });
  }

  /** A refused approval is audited at the approval's own scope (known only after reading it). */
  private async recordApprovalDenied(e: Elevated, body: Cmd, id: string, refusal: ApiError): Promise<void> {
    const p = e.state.principal as Principal;
    const found = await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, async (trx) => {
      const row = await approvals.get(trx, id);
      return row ? { row, permission: (await this.actionPermissions(trx, row.action))[0] } : undefined;
    }).catch(() => undefined);
    if (!found?.permission) return;
    await this.recordDenied(e, this.commandContext(e, body), { target: scopeOf(found.row), permission: found.permission, action: 'approval.decide', objectType: 'second_person_approval', objectId: found.row.id }, refusal)
      .catch((failure: unknown) => this.ctx.log('admin.denied_audit_failed', failure));
  }

  decline(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      const before = await approvals.get(trx, id);
      if (!before) throw new ApiError('access.not_found', 'approval not found');
      const row = await approvals.decide(trx, cmd, id, 'decline', before.action_digest);
      await this.notice(trx, { kind: 'person', id: row.requested_by }, 'admin.approval_decided', { approvalId: row.id, action: row.action, decision: 'decline' });
      return { approval: toApproval(row) };
    }).catch(async (error: unknown) => {
      if (error instanceof ApiError && isAuthorityRefusal(error)) await this.recordApprovalDenied(e, body, id, error);
      throw error;
    });
  }

  withdraw(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const row = await approvals.withdraw(trx, id);
      const permission = (await this.actionPermissions(trx, row.action))[0] ?? 'admin.session.elevate';
      await this.recordApplied(trx, p, cmd, { target: scopeOf(row), permission, action: 'approval.withdrawn', objectType: 'second_person_approval', objectId: row.id });
      return { approval: toApproval(row) };
    });
  }

  /* ---------- Case access grants ---------- */

  requestCaseGrant(e: Elevated, body: z.infer<typeof RequestCaseGrantCommandSchema>) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      const row = await caseGrants.request(trx, cmd, {
        supportCaseId: body.supportCaseId, objectType: body.objectType, objectIds: body.objectIds, projectionClass: body.projectionClass, purpose: body.purpose,
        expiresInSeconds: body.expiresInSeconds, legalExceptionRef: body.legalExceptionRef ?? null,
      });
      await this.notice(trx, { kind: 'case_access_grant', id: row.id }, 'admin.case_grant_requested', { supportCaseId: row.support_case_id, hubId: row.hub_id });
      return { grant: toCaseGrant(row, this.now) };
    });
  }

  decideCaseGrant(e: Elevated, id: string, body: z.infer<typeof DecideCaseGrantCommandSchema>) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      const row = await caseGrants.decide(trx, cmd, id, body.decision, body.requestDigest);
      await this.notice(trx, { kind: 'person', id: row.requested_by }, 'admin.case_grant_decided', { grantId: row.id, decision: body.decision });
      return { grant: toCaseGrant(row, this.now) };
    });
  }

  revokeCaseGrant(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, _p, cmd) => ({ grant: toCaseGrant(await caseGrants.revoke(trx, cmd, id), this.now) }));
  }

  caseGrantsOf(state: RequestState, supportCaseId: string) {
    return this.read(state, async (trx) => ({
      grants: (await trx.selectFrom('case_access_grant').selectAll().where('support_case_id', '=', supportCaseId).orderBy('requested_at').execute()).map((r) => toCaseGrant(r, this.now)),
    }));
  }

  caseGrant(state: RequestState, id: string) {
    return this.read(state, async (trx) => {
      const row = await trx.selectFrom('case_access_grant').selectAll().where('id', '=', id).executeTakeFirst();
      if (!row) throw new ApiError('access.not_found', 'grant not found');
      return { grant: toCaseGrant(row, this.now) };
    });
  }

  /** Does the caller hold a usable (approved, unexpired, unrevoked, own, open-case) grant naming the object? */
  coverage(state: RequestState, objectType: string, objectId: string) {
    return this.read(state, async (trx) => ({ objectType, objectId, covered: await caseGrants.covers(trx, objectType, objectId) }));
  }

  accessLog(state: RequestState, filter: { grantId?: string | undefined; objectId?: string | undefined }) {
    return this.read(state, async (trx) => ({
      entries: (await caseGrants.accessLog(trx, { ...(filter.grantId ? { grantId: filter.grantId } : {}), ...(filter.objectId ? { objectId: filter.objectId } : {}) })).map(toAccessLogEntry),
    }));
  }

  /* ---------- Audit ---------- */

  audit(state: RequestState, q: z.infer<typeof AuditQuerySchema>) {
    return this.read(state, async (trx) => {
      let query = trx.selectFrom('admin_audit_event').selectAll();
      if (q.objectType) query = query.where('object_type', '=', q.objectType);
      if (q.objectId) query = query.where('object_id', '=', q.objectId);
      if (q.actorPersonId) query = query.where('actor_person_id', '=', q.actorPersonId);
      if (q.hubId) query = query.where('hub_id', '=', q.hubId);
      if (q.afterSequence) query = query.where(sql<boolean>`sequence > ${q.afterSequence}::bigint`);
      const limit = Math.min(Math.max(Number(q.limit ?? 200), 1), 500);
      const rows = await query.orderBy('sequence').limit(limit + 1).execute();
      const events = rows.slice(0, limit).map(toAuditEvent);
      return { events, nextAfterSequence: rows.length > limit ? String(events[events.length - 1]?.sequence) : null };
    });
  }

  /**
   * Sequence continuity of the whole mutation audit (HC-153 "verify chain"): only for `admin.audit.read` at the
   * platform scope, the one reader who sees every row, so a gap is a real gap and not a row hidden by scope.
   */
  continuity(state: RequestState) {
    return this.read(state, async (trx) => {
      if (!(await staffAssignments.hasPermission(trx, 'admin.audit.read', { kind: 'platform' }))) throw new ApiError('access.forbidden', 'admin.audit.read at the platform scope is required', { required: 'permission' });
      const { rows } = await sql<{ count: string; first: string | null; last: string | null }>`
        SELECT count(*)::text AS count, min(sequence)::text AS first, max(sequence)::text AS last FROM trustwork.admin_audit_event`.execute(trx);
      const gaps = await sql<{ missing: string }>`
        SELECT s::text AS missing FROM generate_series(1::bigint, coalesce((SELECT max(sequence) FROM trustwork.admin_audit_event), 0)) s
        WHERE NOT EXISTS (SELECT 1 FROM trustwork.admin_audit_event e WHERE e.sequence = s) ORDER BY s LIMIT 20`.execute(trx);
      const head = rows[0] ?? { count: '0', first: null, last: null };
      return { count: Number(head.count), firstSequence: head.first === null ? null : Number(head.first), lastSequence: head.last === null ? null : Number(head.last), gapFree: gaps.rows.length === 0, missing: gaps.rows.map((g) => Number(g.missing)) };
    });
  }

  /* ---------- Moderation (participants) ---------- */

  report(state: RequestState, body: z.infer<typeof ReportContentCommandSchema>) {
    return this.read(state, async (trx) => {
      const row = await moderation.report(trx, { hubId: body.hubId, targetKind: body.targetKind, targetId: body.targetId, clauseCode: body.clauseCode, text: body.text ?? null });
      await this.notice(trx, { kind: 'moderation_report', id: row.id }, 'moderation.report_received', { hubId: row.hub_id, targetKind: row.target_kind });
      return { report: toOwnReport(row) };
    });
  }

  fileAppeal(state: RequestState, body: z.infer<typeof FileAppealCommandSchema>) {
    return this.read(state, async (trx) => {
      const row = await appeals.file(trx, body.subjectKind, body.subjectId, body.reason);
      await this.notice(trx, { kind: 'appeal', id: row.id }, 'moderation.appeal_filed', { hubId: row.hub_id, subjectKind: row.subject_kind });
      return { appeal: { id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, status: row.status, filedAt: new Date(row.filed_at).toISOString() } };
    });
  }

  /** What concerns the caller: cases, sanctions and appeals about them or their employer (no staff identities). */
  ownModeration(state: RequestState) {
    return this.read(state, async (trx, p) => {
      const company = p.membership?.companyId ?? null;
      const about = <T extends { subject_person_id: string | null; subject_company_id: string | null }>(rows: T[]) =>
        rows.filter((r) => r.subject_person_id === p.personId || (company !== null && r.subject_company_id === company));
      const cases = about(await trx.selectFrom('moderation_case').selectAll().orderBy('opened_at', 'desc').limit(200).execute());
      const sanctions = about(await trx.selectFrom('sanction').selectAll().orderBy('created_at', 'desc').limit(200).execute());
      const filed = await trx.selectFrom('appeal').selectAll().where('appellant_person_id', '=', p.personId).orderBy('filed_at', 'desc').limit(200).execute();
      return {
        cases: cases.map((c) => ({ id: c.id, hubId: c.hub_id, targetKind: c.target_kind, targetId: c.target_id, clauseCodes: c.clause_codes, status: c.status, decision: c.decision, decisionReason: c.decision_reason, decidedAt: c.decided_at ? new Date(c.decided_at).toISOString() : null })),
        sanctions: sanctions.map((s) => ({ id: s.id, hubId: s.hub_id, level: s.level, featureScope: s.feature_scope, startsAt: new Date(s.starts_at).toISOString(), endsAt: s.ends_at ? new Date(s.ends_at).toISOString() : null, reason: s.reason, liftedAt: s.lifted_at ? new Date(s.lifted_at).toISOString() : null, moderationCaseId: s.moderation_case_id })),
        appeals: filed.map((a) => ({ id: a.id, subjectKind: a.subject_kind, subjectId: a.subject_id, status: a.status, decisionReason: a.decision_reason, filedAt: new Date(a.filed_at).toISOString(), decidedAt: a.decided_at ? new Date(a.decided_at).toISOString() : null })),
      };
    });
  }

  /* ---------- Moderation (staff) ---------- */

  reports(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ reports: (await trx.selectFrom('moderation_report').selectAll().where('hub_id', '=', hubId).orderBy('created_at').limit(500).execute()).map(toReport) }));
  }

  cases(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ cases: (await trx.selectFrom('moderation_case').selectAll().where('hub_id', '=', hubId).orderBy('opened_at', 'desc').limit(500).execute()).map(toModerationCase) }));
  }

  moderationCase(state: RequestState, id: string) {
    return this.read(state, async (trx) => {
      const row = await this.caseRow(trx, id);
      if (!row) throw new ApiError('access.not_found', 'moderation case not found');
      const sanctions = await trx.selectFrom('sanction').selectAll().where('moderation_case_id', '=', id).orderBy('created_at').execute();
      const sanctionIds = sanctions.map((s) => s.id);
      const related = await trx.selectFrom('appeal').selectAll().where((eb) => eb.or([
        eb.and([eb('subject_kind', '=', 'moderation_case'), eb('subject_id', '=', id)]),
        ...(sanctionIds.length ? [eb.and([eb('subject_kind', '=', 'sanction'), eb('subject_id', 'in', sanctionIds)])] : []),
      ])).orderBy('filed_at').execute();
      return { case: toModerationCase(row), sanctions: sanctions.map(toSanction), appeals: related.map(toAppeal) };
    });
  }

  openCase(e: Elevated, body: z.infer<typeof OpenModerationCaseCommandSchema>) {
    const attempt: Attempt = { target: { kind: 'hub', hubId: body.hubId }, permission: body.emergencyHold ? 'admin.moderation.emergency.hold' : 'admin.moderation.case.open', action: 'moderation.case_open', objectType: 'moderation_case', objectId: body.targetId };
    return this.staff(e, body, attempt, async (trx, p, cmd) => {
      const row = await moderation.openCase(trx, cmd, {
        hubId: body.hubId, targetKind: body.targetKind, targetId: body.targetId, subject: body.subject ?? null, reportIds: body.reportIds ?? [], clauseCodes: body.clauseCodes, emergencyHold: body.emergencyHold ?? false,
      });
      if (row.emergency_hold) await this.moderationTargets.apply(trx, { hubId: row.hub_id, targetKind: row.target_kind, targetId: row.target_id, moderationCaseId: row.id, effect: 'hold', decidedBy: p.personId });
      return { case: toModerationCase(row) };
    });
  }

  decideCase(e: Elevated, id: string, body: z.infer<typeof DecideModerationCaseCommandSchema>) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const row = await moderation.decide(trx, cmd, id, body.decision);
      const effect = decisionEffect(body.decision);
      if (effect !== 'none') await this.moderationTargets.apply(trx, { hubId: row.hub_id, targetKind: row.target_kind, targetId: row.target_id, moderationCaseId: row.id, effect, decidedBy: p.personId });
      const subject = row.subject_person_id ? { kind: 'person', id: row.subject_person_id } : row.subject_company_id ? { kind: 'company', id: row.subject_company_id } : null;
      if (subject) await this.notice(trx, subject, 'moderation.case_decided', { moderationCaseId: row.id, decision: row.decision });
      return { case: toModerationCase(row) };
    });
  }

  /** Levels 1-3 within engine bounds; level 4 consumes the approval of exactly this sanction (a second person). */
  applySanction(e: Elevated, caseId: string, body: z.infer<typeof ApplySanctionCommandSchema>) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      if (body.level === 4 && !body.approvalId) throw new ApiError('access.approval_required', 'a level 4 sanction needs the approval of a second person', { reason: 'approval_required', action: 'moderation.apply_sanction_l4' });
      const row = await moderation.applySanction(trx, cmd, { caseId, level: body.level, featureScope: body.featureScope, durationSeconds: body.durationSeconds, approvalId: body.approvalId ?? null });
      const subject = row.subject_person_id ? { kind: 'person' as const, id: row.subject_person_id } : { kind: 'company' as const, id: row.subject_company_id as string };
      await this.sanctions.changed(trx, { sanctionId: row.id, hubId: row.hub_id, subject, level: row.level, featureScope: row.feature_scope, endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null, change: 'applied' });
      await this.notice(trx, subject, 'moderation.sanction_applied', { sanctionId: row.id, level: row.level, featureScope: row.feature_scope });
      return { sanction: toSanction(row) };
    }).catch(async (error: unknown) => {
      if (error instanceof ApiError && isAuthorityRefusal(error)) await this.recordCaseDenied(e, body, caseId, error, body.level === 4 ? 'moderation.apply_sanction_l4' : 'moderation.apply_sanction');
      throw error;
    });
  }

  private async recordCaseDenied(e: Elevated, body: Cmd, caseId: string, refusal: ApiError, action: string): Promise<void> {
    const p = e.state.principal as Principal;
    const row = await withPrincipal(this.ctx.pool, { personId: p.personId, authzEpoch: p.authzEpoch }, (trx) => this.caseRow(trx, caseId)).catch(() => undefined);
    if (!row) return;
    await this.recordDenied(e, this.commandContext(e, body), { target: { kind: 'hub', hubId: row.hub_id }, permission: 'admin.moderation.decide', action, objectType: 'moderation_case', objectId: row.id }, refusal)
      .catch((failure: unknown) => this.ctx.log('admin.denied_audit_failed', failure));
  }

  liftSanction(e: Elevated, id: string, body: Cmd) {
    return this.staff(e, body, null, async (trx, _p, cmd) => {
      const row = await moderation.liftSanction(trx, cmd, id);
      const subject = row.subject_person_id ? { kind: 'person' as const, id: row.subject_person_id } : { kind: 'company' as const, id: row.subject_company_id as string };
      await this.sanctions.changed(trx, { sanctionId: row.id, hubId: row.hub_id, subject, level: row.level, featureScope: row.feature_scope, endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null, change: 'lifted' });
      await this.notice(trx, subject, 'moderation.sanction_lifted', { sanctionId: row.id });
      return { sanction: toSanction(row) };
    });
  }

  appealsOf(state: RequestState, hubId: string) {
    return this.read(state, async (trx) => ({ appeals: (await trx.selectFrom('appeal').selectAll().where('hub_id', '=', hubId).orderBy('filed_at').limit(500).execute()).map(toAppeal) }));
  }

  decideAppeal(e: Elevated, id: string, body: z.infer<typeof DecideAppealCommandSchema>) {
    return this.staff(e, body, null, async (trx, p, cmd) => {
      const row = await appeals.decide(trx, cmd, id, body.decision);
      if (row.subject_kind === 'sanction' && body.decision === 'overturned') {
        const s = await trx.selectFrom('sanction').selectAll().where('id', '=', row.subject_id).executeTakeFirst();
        if (s) {
          const subject = s.subject_person_id ? { kind: 'person' as const, id: s.subject_person_id } : { kind: 'company' as const, id: s.subject_company_id as string };
          await this.sanctions.changed(trx, { sanctionId: s.id, hubId: s.hub_id, subject, level: s.level, featureScope: s.feature_scope, endsAt: s.ends_at ? new Date(s.ends_at).toISOString() : null, change: 'lifted' });
        }
      }
      if (row.subject_kind === 'moderation_case' && body.decision === 'overturned') {
        const c = await this.caseRow(trx, row.subject_id);
        if (c && c.decision === 'content_removed') await this.moderationTargets.apply(trx, { hubId: c.hub_id, targetKind: c.target_kind, targetId: c.target_id, moderationCaseId: c.id, effect: 'restore', decidedBy: p.personId });
      }
      await this.notice(trx, { kind: 'person', id: row.appellant_person_id }, 'moderation.appeal_decided', { appealId: row.id, decision: row.status });
      return { appeal: toAppeal(row) };
    });
  }

  /* ---------- Feature flags ---------- */

  flags(state: RequestState, filter: { hubId?: string | undefined; nodeId?: string | undefined }) {
    return this.read(state, async (trx) => ({ flags: (await featureFlags.list(trx, { ...(filter.hubId ? { hubId: filter.hubId } : {}), ...(filter.nodeId ? { nodeId: filter.nodeId } : {}) })).map(toFlag) }));
  }

  setFlag(e: Elevated, body: z.infer<typeof SetFlagCommandSchema>) {
    const attempt: Attempt = { target: body.scope, permission: 'admin.flags.edit', action: 'flags.set', objectType: 'feature_flag', objectId: e.elevationId };
    return this.staff(e, body, attempt, async (trx, _p, cmd) => ({
      flag: toFlag(await featureFlags.set(trx, cmd, { scope: body.scope, key: body.key, value: body.value, description: body.description, declaredEffect: body.declaredEffect, expiresAt: new Date(body.expiresAt) })),
    }));
  }

}
