import { sql, type RawBuilder } from 'kysely';
import { computeDigest, ScopedStaffRoleDefinitionSchema, type ScopedStaffRoleDefinition } from '../../../contracts/src/index.js';
import type { Transaction } from '../pool.js';
import type {
  AccessLogEntryRow, AccessLogKind, AdminAuditEventRow, AppealRow, AppealSubjectKind, AuditOutcome, CaseAccessGrantRow, FeatureFlagRow, FlagEffect, IncidentKind, IncidentRow,
  IncidentSeverity, IncidentStatus, KillSwitchRow, KillSwitchScopeKind, MaintenanceWindowRow, ModerationCaseRow, ModerationDecision, ModerationReportRow, ProjectionClass,
  SanctionRow, SecondPersonApprovalRow, StaffConflictDeclarationRow, StaffRole, StaffRoleAssignmentRow, StaffRoleDefinitionRow, SupportCaseNoteRow,
  SupportCaseRow, SupportCaseStatus, SupportPriority,
} from '../schema/admin.js';

/**
 * Administration persistence (DATA-002). Three kinds of calls:
 *
 * - Staff commands run under `withPrincipal` as the staff member and go only through the SECURITY DEFINER functions of
 *   packages/data/migrations/admin. Each takes a `CommandContext` (a live elevation of the caller from BE-004's
 *   `session_elevation`, created after second-factor step-up by `sessionElevations.insert`, a request id and a reason); the database checks the permission at the scope, conflicts of interest and second-person rules, and
 *   writes the admin_audit_event row in the same transaction. Refusals are SQLSTATE 42501 / 23514 / P0002 with an
 *   `admin.*` hint (P0002 `admin.not_found` wherever existence must not leak).
 * - Participant calls (opening one's own support case, reporting content, filing an appeal, a requester's reply) run
 *   under `withPrincipal` without elevation.
 * - Owner-run calls (marked "owner-run") need a `withMaintenance` transaction: the node anchor, role definition
 *   releases from the capability map, the setup wizard's first administrator, and appeals filed by other modules.
 *
 * Digests: `adminDigests` computes, with the contracts' trustwork-digest-1, exactly what the database recomputes, so a
 * requester asks for approval of the digest the executing command will check.
 */
export interface CommandContext {
  elevationId: string;
  requestId: string;
  reasonCode: string;
  reasonText: string;
  clientFingerprintHash?: string;
}
export type StaffScope = { kind: 'platform' } | { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string };
export type PartyRef = { kind: 'person' | 'company'; id: string };
/** A target for permission checks: the platform, the node, or a hub. */
export type StaffTarget = StaffScope;

const node = (scope: StaffScope): string | null => (scope.kind === 'node' ? scope.nodeId : null);
const hub = (scope: StaffScope): string | null => (scope.kind === 'hub' ? scope.hubId : null);
const ctxJson = (ctx: CommandContext): string => JSON.stringify(ctx);
const scopeJson = (scope: StaffScope) => (scope.kind === 'platform' ? { kind: 'platform' } : scope.kind === 'node' ? { kind: 'node', nodeId: scope.nodeId } : { kind: 'hub', hubId: scope.hubId });
const seconds = (value: number | null | undefined): string | null => (value === null || value === undefined ? null : `${Math.round(value)} seconds`);

async function one<T>(query: RawBuilder<T>, trx: Transaction, what: string): Promise<T> {
  const { rows } = await query.execute(trx);
  const row = rows[0];
  if (!row) throw new Error(`${what} returned no row`);
  return row;
}

export const adminDigests = {
  /** staff.assign_sensitive_role or staff.grant_breakglass: the assignment exactly as `admin_assign_role` will make it. */
  assignment(input: { breakglass: boolean; personId: string; role: StaffRole; scope: StaffScope; definitionVersion: number; incidentId?: string | null; validForSeconds?: number | null }): string {
    return computeDigest({
      action: input.breakglass ? 'staff.grant_breakglass' : 'staff.assign_sensitive_role', personId: input.personId, role: input.role, scope: scopeJson(input.scope),
      definitionVersion: input.definitionVersion, breakglass: input.breakglass, incidentId: input.incidentId ?? null, validForSeconds: input.validForSeconds ?? null,
    }).value;
  },
  /** The request digest of a case access grant (what the approver restates). */
  caseGrant(input: { supportCaseId: string; objectType: string; objectIds: string[]; projectionClass: ProjectionClass; purpose: string; expiresInSeconds: number; legalExceptionRef?: string | null }): string {
    return computeDigest({
      supportCaseId: input.supportCaseId, objectSelector: { type: input.objectType, ids: [...new Set(input.objectIds)].sort() }, projectionClass: input.projectionClass,
      excludedFieldClasses: ['credentials', 'negotiation_private', 'payment_refs'], purpose: input.purpose, expiresInSeconds: input.expiresInSeconds, legalExceptionRef: input.legalExceptionRef ?? null,
    }).value;
  },
  /** moderation.apply_sanction_l4. */
  sanction(input: { moderationCaseId: string; subject: PartyRef; level: number; featureScope: string; durationSeconds: number | null }): string {
    return computeDigest({
      action: 'moderation.apply_sanction_l4', moderationCaseId: input.moderationCaseId, subject: { kind: input.subject.kind, id: input.subject.id }, level: input.level,
      featureScope: input.featureScope, durationSeconds: input.durationSeconds,
    }).value;
  },
  /** kill_switch.release. */
  killSwitchRelease(killSwitchId: string, incidentNote: string): string {
    return computeDigest({ action: 'kill_switch.release', killSwitchId, incidentNote }).value;
  },
};

export const adminSetup = {
  /** Owner-run (setup wizard): the node anchor, once. */
  async createNode(trx: Transaction, label: string): Promise<{ id: string }> {
    return trx.insertInto('admin_node').values({ label }).returning('id').executeTakeFirstOrThrow();
  },
  async node(trx: Transaction): Promise<{ id: string; label: string } | undefined> {
    return trx.selectFrom('admin_node').select(['id', 'label']).executeTakeFirst();
  },
  /** Owner-run (setup wizard step first_admin): at most two founding administrators, before any console assignment. */
  async bootstrapFirstAdmin(trx: Transaction, input: { personId: string; role: StaffRole; scope: StaffScope; definitionVersion: number; reason: string }): Promise<StaffRoleAssignmentRow> {
    return trx.insertInto('staff_role_assignment').values({
      person_id: input.personId, role: input.role, scope_kind: input.scope.kind, node_id: node(input.scope), hub_id: hub(input.scope), definition_version: input.definitionVersion,
      granted_by: null, reason: input.reason, setup_bootstrap: true,
    }).returningAll().executeTakeFirstOrThrow();
  },
};

export const staffRoleDefinitions = {
  /** Owner-run: releases a role definition from the capability map after validating it against the console contract. */
  async release(trx: Transaction, input: Omit<ScopedStaffRoleDefinition, 'releasedAt' | 'releasedBy'> & { releasedBy: string | null }): Promise<StaffRoleDefinitionRow> {
    const def = ScopedStaffRoleDefinitionSchema.parse({ ...input, releasedAt: new Date().toISOString(), releasedBy: input.releasedBy ?? 'engine' });
    return trx.insertInto('staff_role_definition_version').values({
      role: def.role, version: def.version, scopes: def.scopes, permissions: def.permissions, credit_cap_minor: def.caps.creditCapMinorUnits,
      grant_max_hours: def.caps.grantMaxHours, sod_conflicts: def.sodConflicts, sod_mode: def.sodMode, released_by: input.releasedBy,
    }).returningAll().executeTakeFirstOrThrow();
  },
  async list(trx: Transaction): Promise<StaffRoleDefinitionRow[]> {
    return trx.selectFrom('staff_role_definition_version').selectAll().orderBy('role').orderBy('version').execute();
  },
};

export const staffAssignments = {
  /** admin.staff.assign (or admin.staff.breakglass); sensitive and break-glass roles need `approvalId` (see adminDigests.assignment). */
  async assign(trx: Transaction, ctx: CommandContext, input: {
    personId: string; role: StaffRole; scope: StaffScope; definitionVersion: number; validForSeconds?: number | null; breakglass?: boolean; incidentId?: string | null; approvalId?: string | null;
  }): Promise<StaffRoleAssignmentRow> {
    return one(sql<StaffRoleAssignmentRow>`SELECT * FROM trustwork.admin_assign_role(${ctxJson(ctx)}::jsonb, ${input.personId}::uuid, ${input.role}, ${input.scope.kind},
      ${node(input.scope)}::uuid, ${hub(input.scope)}::uuid, ${input.definitionVersion}::integer, ${seconds(input.validForSeconds)}::interval, ${input.breakglass ?? false},
      ${input.incidentId ?? null}::uuid, ${input.approvalId ?? null}::uuid)`, trx, 'admin_assign_role');
  },
  async revoke(trx: Transaction, ctx: CommandContext, assignmentId: string): Promise<StaffRoleAssignmentRow> {
    return one(sql<StaffRoleAssignmentRow>`SELECT * FROM trustwork.admin_revoke_role(${ctxJson(ctx)}::jsonb, ${assignmentId}::uuid)`, trx, 'admin_revoke_role');
  },
  /** Rows the caller may see (their own, or those covered by admin.staff.read). */
  async list(trx: Transaction, filter: { personId?: string; activeOnly?: boolean } = {}): Promise<StaffRoleAssignmentRow[]> {
    let query = trx.selectFrom('staff_role_assignment').selectAll();
    if (filter.personId) query = query.where('person_id', '=', filter.personId);
    if (filter.activeOnly) query = query.where('revoked_at', 'is', null).where((eb) => eb.or([eb('valid_until', 'is', null), eb('valid_until', '>', sql<Date>`now()`)]));
    return query.orderBy('created_at').execute();
  },
  /** Does the caller hold the permission at the target right now? */
  async hasPermission(trx: Transaction, permission: string, target: StaffTarget): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.admin_has_permission(${permission}, ${node(target)}::uuid, ${hub(target)}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },
};

export const approvals = {
  async request(trx: Transaction, ctx: CommandContext, input: { action: string; scope: StaffScope; actionDigest: string }): Promise<SecondPersonApprovalRow> {
    return one(sql<SecondPersonApprovalRow>`SELECT * FROM trustwork.admin_request_approval(${ctxJson(ctx)}::jsonb, ${input.action}, ${input.scope.kind}, ${node(input.scope)}::uuid,
      ${hub(input.scope)}::uuid, ${input.actionDigest})`, trx, 'admin_request_approval');
  },
  /** The second person restates the digest they reviewed; an approval lasts at most 72 hours. */
  async decide(trx: Transaction, ctx: CommandContext, approvalId: string, decision: 'approve' | 'decline', actionDigest: string, validForSeconds = 72 * 3600): Promise<SecondPersonApprovalRow> {
    return one(sql<SecondPersonApprovalRow>`SELECT * FROM trustwork.admin_decide_approval(${ctxJson(ctx)}::jsonb, ${approvalId}::uuid, ${decision}, ${actionDigest},
      ${seconds(validForSeconds)}::interval)`, trx, 'admin_decide_approval');
  },
  async withdraw(trx: Transaction, approvalId: string): Promise<SecondPersonApprovalRow> {
    return one(sql<SecondPersonApprovalRow>`SELECT * FROM trustwork.admin_withdraw_approval(${approvalId}::uuid)`, trx, 'admin_withdraw_approval');
  },
  /** For other modules' commands: executes the approval once, as its requester; `ref` names what was executed. */
  async consume(trx: Transaction, input: { approvalId: string; action: string; scope: StaffScope; actionDigest: string; ref: string }): Promise<SecondPersonApprovalRow> {
    return one(sql<SecondPersonApprovalRow>`SELECT * FROM trustwork.admin_consume_approval(${input.approvalId}::uuid, ${input.action}, ${input.scope.kind}, ${node(input.scope)}::uuid,
      ${hub(input.scope)}::uuid, ${input.actionDigest}, ${input.ref}::uuid)`, trx, 'admin_consume_approval');
  },
  async get(trx: Transaction, approvalId: string): Promise<SecondPersonApprovalRow | undefined> {
    return trx.selectFrom('second_person_approval').selectAll().where('id', '=', approvalId).executeTakeFirst();
  },
};

export const staffConflicts = {
  async declare(trx: Transaction, party: PartyRef, reason: string): Promise<StaffConflictDeclarationRow> {
    return one(sql<StaffConflictDeclarationRow>`SELECT * FROM trustwork.admin_declare_conflict(${party.kind === 'person' ? party.id : null}::uuid,
      ${party.kind === 'company' ? party.id : null}::uuid, ${reason})`, trx, 'admin_declare_conflict');
  },
  async end(trx: Transaction, ctx: CommandContext, declarationId: string): Promise<StaffConflictDeclarationRow> {
    return one(sql<StaffConflictDeclarationRow>`SELECT * FROM trustwork.admin_end_conflict(${ctxJson(ctx)}::jsonb, ${declarationId}::uuid)`, trx, 'admin_end_conflict');
  },
};

export const incidents = {
  async open(trx: Transaction, ctx: CommandContext, input: { scope: { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; kind: IncidentKind; severity: IncidentSeverity; title: string; notificationDeadline?: Date | null }): Promise<IncidentRow> {
    return one(sql<IncidentRow>`SELECT * FROM trustwork.admin_open_incident(${ctxJson(ctx)}::jsonb, ${node(input.scope)}::uuid, ${hub(input.scope)}::uuid, ${input.kind}, ${input.severity},
      ${input.title}, ${input.notificationDeadline ?? null}::timestamptz)`, trx, 'admin_open_incident');
  },
  async update(trx: Transaction, ctx: CommandContext, incidentId: string, input: { status: IncidentStatus; postReviewRef?: string | null; link?: Record<string, unknown> | null }): Promise<IncidentRow> {
    return one(sql<IncidentRow>`SELECT * FROM trustwork.admin_update_incident(${ctxJson(ctx)}::jsonb, ${incidentId}::uuid, ${input.status}, ${input.postReviewRef ?? null},
      ${input.link ? JSON.stringify(input.link) : null}::jsonb)`, trx, 'admin_update_incident');
  },
};

export const adminAudit = {
  /**
   * Runtime INSERT for outcomes the commands cannot record themselves (denied or failed attempts, in their own
   * transaction). The database assigns id, sequence and time, and checks that the caller holds `actorRole` at a covering
   * scope and owns the elevation. Audit rows are never updated or deleted, by anyone.
   */
  async append(trx: Transaction, input: {
    actorPersonId: string; actorRole: StaffRole; scope: StaffScope; permission: string; elevationId: string; action: string; objectType: string; objectId: string;
    reasonCode: string; reasonText: string; outcome: AuditOutcome; requestId: string; caseId?: string | null; clientFingerprintHash?: string | null;
  }): Promise<void> {
    await trx.insertInto('admin_audit_event').values({
      actor_person_id: input.actorPersonId, actor_role: input.actorRole, scope_kind: input.scope.kind, node_id: node(input.scope), hub_id: hub(input.scope), permission: input.permission,
      session_elevation_id: input.elevationId, action: input.action, object_type: input.objectType, object_id: input.objectId, reason_code: input.reasonCode,
      reason_text: input.reasonText, outcome: input.outcome, request_id: input.requestId, case_id: input.caseId ?? null, client_fingerprint_hash: input.clientFingerprintHash ?? null,
    }).execute();
  },
  /** Rows the caller may read (own actions, or admin.audit.read at the scope), in sequence order. */
  async list(trx: Transaction, filter: { objectType?: string; objectId?: string; actorPersonId?: string; limit?: number } = {}): Promise<AdminAuditEventRow[]> {
    let query = trx.selectFrom('admin_audit_event').selectAll();
    if (filter.objectType) query = query.where('object_type', '=', filter.objectType);
    if (filter.objectId) query = query.where('object_id', '=', filter.objectId);
    if (filter.actorPersonId) query = query.where('actor_person_id', '=', filter.actorPersonId);
    return query.orderBy('sequence').limit(filter.limit ?? 500).execute();
  },
};

export const supportCases = {
  /** Participant path: a case about oneself, or (with company.members.manage) about one's active employer. */
  async openOwn(trx: Transaction, input: { hubId: string; forCompany?: boolean; category: string; summary: string }): Promise<SupportCaseRow> {
    return one(sql<SupportCaseRow>`SELECT * FROM trustwork.admin_open_own_support_case(${input.hubId}::uuid, ${input.forCompany ?? false}, ${input.category}, ${input.summary})`, trx, 'admin_open_own_support_case');
  },
  /** admin.support.case.create: on someone's behalf, never about oneself, one's employer or a declared party. */
  async open(trx: Transaction, ctx: CommandContext, input: { hubId: string; requesterPersonId: string; subject: PartyRef; category: string; summary: string; priority?: SupportPriority }): Promise<SupportCaseRow> {
    return one(sql<SupportCaseRow>`SELECT * FROM trustwork.admin_open_support_case(${ctxJson(ctx)}::jsonb, ${input.hubId}::uuid, ${input.requesterPersonId}::uuid,
      ${input.subject.kind === 'person' ? input.subject.id : null}::uuid, ${input.subject.kind === 'company' ? input.subject.id : null}::uuid, ${input.category}, ${input.summary},
      ${input.priority ?? 'normal'})`, trx, 'admin_open_support_case');
  },
  /** Lifecycle, assignment and priority; closing needs admin.support.case.close and revokes the case's grants. */
  async update(trx: Transaction, ctx: CommandContext, caseId: string, input: { status?: SupportCaseStatus; assignedTo?: string | null; priority?: SupportPriority; resolutionCode?: string | null }): Promise<SupportCaseRow> {
    return one(sql<SupportCaseRow>`SELECT * FROM trustwork.admin_update_support_case(${ctxJson(ctx)}::jsonb, ${caseId}::uuid, ${input.status ?? null}, ${input.assignedTo ?? null}::uuid,
      ${input.priority ?? null}, ${input.resolutionCode ?? null})`, trx, 'admin_update_support_case');
  },
  /** The requester answers, reopens or confirms. */
  async requesterUpdate(trx: Transaction, caseId: string, status: 'triaged' | 'open' | 'closed'): Promise<SupportCaseRow> {
    return one(sql<SupportCaseRow>`SELECT * FROM trustwork.admin_requester_update_case(${caseId}::uuid, ${status})`, trx, 'admin_requester_update_case');
  },
  async addNote(trx: Transaction, ctx: CommandContext, caseId: string, body: string, visibility: 'internal' | 'requester'): Promise<SupportCaseNoteRow> {
    return one(sql<SupportCaseNoteRow>`SELECT * FROM trustwork.admin_add_case_note(${ctxJson(ctx)}::jsonb, ${caseId}::uuid, ${body}, ${visibility})`, trx, 'admin_add_case_note');
  },
  async addRequesterNote(trx: Transaction, caseId: string, body: string): Promise<SupportCaseNoteRow> {
    return one(sql<SupportCaseNoteRow>`SELECT * FROM trustwork.admin_add_requester_note(${caseId}::uuid, ${body})`, trx, 'admin_add_requester_note');
  },
  async get(trx: Transaction, caseId: string): Promise<SupportCaseRow | undefined> {
    return trx.selectFrom('support_case').selectAll().where('id', '=', caseId).executeTakeFirst();
  },
  async notes(trx: Transaction, caseId: string): Promise<SupportCaseNoteRow[]> {
    return trx.selectFrom('support_case_note').selectAll().where('support_case_id', '=', caseId).orderBy('created_at').execute();
  },
};

export const caseGrants = {
  /** admin.support.grant.request inside an open case; at most 72 hours and the role's grant cap. */
  async request(trx: Transaction, ctx: CommandContext, input: {
    supportCaseId: string; objectType: string; objectIds: string[]; projectionClass: ProjectionClass; purpose: string; expiresInSeconds: number; legalExceptionRef?: string | null;
  }): Promise<CaseAccessGrantRow> {
    return one(sql<CaseAccessGrantRow>`SELECT * FROM trustwork.admin_request_case_grant(${ctxJson(ctx)}::jsonb, ${input.supportCaseId}::uuid, ${input.objectType}, ${input.objectIds}::uuid[],
      ${input.projectionClass}, ${input.purpose}, ${seconds(input.expiresInSeconds)}::interval, ${input.legalExceptionRef ?? null})`, trx, 'admin_request_case_grant');
  },
  /** admin.support.grant.approve by a different person, restating the request digest. */
  async decide(trx: Transaction, ctx: CommandContext, grantId: string, decision: 'approve' | 'deny', requestDigest: string): Promise<CaseAccessGrantRow> {
    return one(sql<CaseAccessGrantRow>`SELECT * FROM trustwork.admin_decide_case_grant(${ctxJson(ctx)}::jsonb, ${grantId}::uuid, ${decision}, ${requestDigest})`, trx, 'admin_decide_case_grant');
  },
  async revoke(trx: Transaction, ctx: CommandContext, grantId: string): Promise<CaseAccessGrantRow> {
    return one(sql<CaseAccessGrantRow>`SELECT * FROM trustwork.admin_revoke_case_grant(${ctxJson(ctx)}::jsonb, ${grantId}::uuid)`, trx, 'admin_revoke_case_grant');
  },
  /** For staff_case projections: does the caller hold a usable grant naming the object? */
  async covers(trx: Transaction, objectType: string, objectId: string): Promise<boolean> {
    const { rows } = await sql<{ ok: boolean }>`SELECT trustwork.admin_case_grant_covers(${objectType}, ${objectId}::uuid) AS ok`.execute(trx);
    return rows[0]?.ok === true;
  },
  /** Every read under a grant writes one access-log row (the caller is the grantee). */
  async logAccess(trx: Transaction, input: { actorPersonId: string; grantId: string; caseId: string; hubId: string; kind: AccessLogKind; objectType: string; objectId: string; fieldsHash: string }): Promise<void> {
    await trx.insertInto('access_log_entry').values({
      actor_person_id: input.actorPersonId, grant_id: input.grantId, case_id: input.caseId, hub_id: input.hubId, kind: input.kind, object_type: input.objectType,
      object_id: input.objectId, fields_hash: input.fieldsHash,
    }).execute();
  },
  /** The staff path to evidence files (restricted ones need the `evidence` projection class); logs the read. */
  async evidence(trx: Transaction, grantId: string, artifactId: string, fieldsHash: string): Promise<{
    id: string; owner_person_id: string | null; owner_company_id: string | null; parent_kind: string; parent_id: string; classification: string; storage_key: string; sha256: string; bytes: string; media_type: string;
  }> {
    return one(sql<{ id: string; owner_person_id: string | null; owner_company_id: string | null; parent_kind: string; parent_id: string; classification: string; storage_key: string; sha256: string; bytes: string; media_type: string }>`
      SELECT * FROM trustwork.admin_case_evidence(${grantId}::uuid, ${artifactId}::uuid, ${fieldsHash})`, trx, 'admin_case_evidence');
  },
  async accessLog(trx: Transaction, filter: { grantId?: string; objectId?: string } = {}): Promise<AccessLogEntryRow[]> {
    let query = trx.selectFrom('access_log_entry').selectAll();
    if (filter.grantId) query = query.where('grant_id', '=', filter.grantId);
    if (filter.objectId) query = query.where('object_id', '=', filter.objectId);
    return query.orderBy('sequence').execute();
  },
};

export const moderation = {
  /** Participant path. */
  async report(trx: Transaction, input: { hubId: string; targetKind: string; targetId: string; clauseCode: string; text?: string | null }): Promise<ModerationReportRow> {
    return one(sql<ModerationReportRow>`SELECT * FROM trustwork.admin_report_content(${input.hubId}::uuid, ${input.targetKind}, ${input.targetId}::uuid, ${input.clauseCode}, ${input.text ?? null})`, trx, 'admin_report_content');
  },
  async openCase(trx: Transaction, ctx: CommandContext, input: {
    hubId: string; targetKind: string; targetId: string; subject?: PartyRef | null; reportIds?: string[]; clauseCodes: string[]; emergencyHold?: boolean;
  }): Promise<ModerationCaseRow> {
    return one(sql<ModerationCaseRow>`SELECT * FROM trustwork.admin_open_moderation_case(${ctxJson(ctx)}::jsonb, ${input.hubId}::uuid, ${input.targetKind}, ${input.targetId}::uuid,
      ${input.subject?.kind === 'person' ? input.subject.id : null}::uuid, ${input.subject?.kind === 'company' ? input.subject.id : null}::uuid, ${input.reportIds ?? []}::uuid[],
      ${input.clauseCodes}::text[], ${input.emergencyHold ?? false})`, trx, 'admin_open_moderation_case');
  },
  async decide(trx: Transaction, ctx: CommandContext, caseId: string, decision: ModerationDecision): Promise<ModerationCaseRow> {
    return one(sql<ModerationCaseRow>`SELECT * FROM trustwork.admin_decide_moderation_case(${ctxJson(ctx)}::jsonb, ${caseId}::uuid, ${decision})`, trx, 'admin_decide_moderation_case');
  },
  /** Levels 1-3 within engine bounds; level 4 consumes `approvalId` (see adminDigests.sanction). */
  async applySanction(trx: Transaction, ctx: CommandContext, input: { caseId: string; level: 1 | 2 | 3 | 4; featureScope: string; durationSeconds: number | null; approvalId?: string | null }): Promise<SanctionRow> {
    return one(sql<SanctionRow>`SELECT * FROM trustwork.admin_apply_sanction(${ctxJson(ctx)}::jsonb, ${input.caseId}::uuid, ${input.level}::integer, ${input.featureScope},
      ${seconds(input.durationSeconds)}::interval, ${input.approvalId ?? null}::uuid)`, trx, 'admin_apply_sanction');
  },
  async liftSanction(trx: Transaction, ctx: CommandContext, sanctionId: string): Promise<SanctionRow> {
    return one(sql<SanctionRow>`SELECT * FROM trustwork.admin_lift_sanction(${ctxJson(ctx)}::jsonb, ${sanctionId}::uuid)`, trx, 'admin_lift_sanction');
  },
};

export const appeals = {
  /** Participant path for sanctions and moderation decisions about the caller (or their employer). */
  async file(trx: Transaction, subjectKind: 'sanction' | 'moderation_case', subjectId: string, reason: string): Promise<AppealRow> {
    return one(sql<AppealRow>`SELECT * FROM trustwork.admin_file_appeal(${subjectKind}, ${subjectId}::uuid, ${reason})`, trx, 'admin_file_appeal');
  },
  /** Owner-run: another module files an appeal on its own decision (it knows the subject and the original decider). */
  async fileForSubject(trx: Transaction, input: { hubId: string; subjectKind: Exclude<AppealSubjectKind, 'sanction' | 'moderation_case'>; subjectId: string; appellantPersonId: string; appellantCompanyId?: string | null; reason: string; originalDecidedBy: string }): Promise<AppealRow> {
    return trx.insertInto('appeal').values({
      hub_id: input.hubId, subject_kind: input.subjectKind, subject_id: input.subjectId, appellant_person_id: input.appellantPersonId, appellant_company_id: input.appellantCompanyId ?? null,
      reason: input.reason, original_decided_by: input.originalDecidedBy,
    }).returningAll().executeTakeFirstOrThrow();
  },
  async decide(trx: Transaction, ctx: CommandContext, appealId: string, decision: 'upheld' | 'overturned' | 'partially_overturned'): Promise<AppealRow> {
    return one(sql<AppealRow>`SELECT * FROM trustwork.admin_decide_appeal(${ctxJson(ctx)}::jsonb, ${appealId}::uuid, ${decision})`, trx, 'admin_decide_appeal');
  },
};

export const featureFlags = {
  async set(trx: Transaction, ctx: CommandContext, input: { scope: { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; key: string; value: unknown; description: string; declaredEffect: FlagEffect; expiresAt: Date }): Promise<FeatureFlagRow> {
    return one(sql<FeatureFlagRow>`SELECT * FROM trustwork.admin_set_feature_flag(${ctxJson(ctx)}::jsonb, ${node(input.scope)}::uuid, ${hub(input.scope)}::uuid, ${input.key},
      ${JSON.stringify(input.value)}::jsonb, ${input.description}, ${input.declaredEffect}, ${input.expiresAt}::timestamptz)`, trx, 'admin_set_feature_flag');
  },
  async list(trx: Transaction, scope: { hubId?: string; nodeId?: string } = {}): Promise<FeatureFlagRow[]> {
    let query = trx.selectFrom('feature_flag').selectAll().where('expires_at', '>', sql<Date>`now()`);
    if (scope.hubId) query = query.where('hub_id', '=', scope.hubId);
    if (scope.nodeId) query = query.where('node_id', '=', scope.nodeId);
    return query.orderBy('key').execute();
  },
};

export const maintenanceWindows = {
  async schedule(trx: Transaction, ctx: CommandContext, input: { scope: { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; startsAt: Date; endsAt: Date; readOnly?: boolean }): Promise<MaintenanceWindowRow> {
    return one(sql<MaintenanceWindowRow>`SELECT * FROM trustwork.admin_schedule_maintenance(${ctxJson(ctx)}::jsonb, ${node(input.scope)}::uuid, ${hub(input.scope)}::uuid,
      ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.readOnly ?? true})`, trx, 'admin_schedule_maintenance');
  },
  async cancel(trx: Transaction, ctx: CommandContext, windowId: string): Promise<MaintenanceWindowRow> {
    return one(sql<MaintenanceWindowRow>`SELECT * FROM trustwork.admin_cancel_maintenance(${ctxJson(ctx)}::jsonb, ${windowId}::uuid)`, trx, 'admin_cancel_maintenance');
  },
  /** Windows in force at `at` (banner state; no identity needed). */
  async active(trx: Transaction, at: Date = new Date()): Promise<MaintenanceWindowRow[]> {
    return trx.selectFrom('maintenance_window').selectAll().where('cancelled_at', 'is', null).where('starts_at', '<=', at).where('ends_at', '>', at).execute();
  },
};

export type KillSwitchTarget = { moduleKey?: string; action?: string; extensionId?: string; connectionId?: string; job?: string; pipelineId?: string };
export const killSwitches = {
  /** Immediate, one person. */
  async engage(trx: Transaction, ctx: CommandContext, input: { scopeKind: KillSwitchScopeKind; scope: { kind: 'node'; nodeId: string } | { kind: 'hub'; hubId: string }; target?: KillSwitchTarget; incidentId?: string | null }): Promise<KillSwitchRow> {
    return one(sql<KillSwitchRow>`SELECT * FROM trustwork.admin_engage_kill_switch(${ctxJson(ctx)}::jsonb, ${input.scopeKind}, ${node(input.scope)}::uuid, ${hub(input.scope)}::uuid,
      ${JSON.stringify(input.target ?? {})}::jsonb, ${input.incidentId ?? null}::uuid)`, trx, 'admin_engage_kill_switch');
  },
  /** Needs an approval of `kill_switch.release` with adminDigests.killSwitchRelease, requested by the releaser. */
  async release(trx: Transaction, ctx: CommandContext, killSwitchId: string, approvalId: string, incidentNote: string): Promise<KillSwitchRow> {
    return one(sql<KillSwitchRow>`SELECT * FROM trustwork.admin_release_kill_switch(${ctxJson(ctx)}::jsonb, ${killSwitchId}::uuid, ${approvalId}::uuid, ${incidentNote})`, trx, 'admin_release_kill_switch');
  },
  async engaged(trx: Transaction): Promise<KillSwitchRow[]> {
    return trx.selectFrom('kill_switch').selectAll().where('state', '=', 'engaged').orderBy('engaged_at').execute();
  },
};
