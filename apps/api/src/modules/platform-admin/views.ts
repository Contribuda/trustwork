import type { StaffScope } from '../../deps/contracts.js';
import type {
  AccessLogEntryRow, AdminAuditEventRow, AppealRow, CaseAccessGrantRow, FeatureFlagRow, IncidentRow, ModerationCaseRow, ModerationReportRow, SanctionRow, SecondPersonApprovalRow,
  StaffConflictDeclarationRow, StaffRoleAssignmentRow, StaffRoleDefinitionRow,
} from './deps.js';

/**
 * Row-to-view serializers (camelCase, ISO timestamps, digests as hex). Views carry staff configuration, decisions and
 * digests only: no private customer object, no reporter identity in moderation views, no secret.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const req = (d: Date): string => new Date(d).toISOString();

export function scopeOf(row: { scope_kind: string; node_id: string | null; hub_id: string | null }): StaffScope {
  if (row.scope_kind === 'node') return { kind: 'node', nodeId: row.node_id as string };
  if (row.scope_kind === 'hub') return { kind: 'hub', hubId: row.hub_id as string };
  return { kind: 'platform' };
}

export const toDefinition = (r: StaffRoleDefinitionRow) => ({
  role: r.role, version: r.version, scopes: r.scopes, permissions: [...r.permissions].sort(), caps: { creditCapMinorUnits: r.credit_cap_minor, grantMaxHours: r.grant_max_hours },
  sodConflicts: r.sod_conflicts, sodMode: r.sod_mode, releasedAt: req(r.released_at), releasedBy: r.released_by,
});

export const toAssignment = (r: StaffRoleAssignmentRow) => ({
  id: r.id, personId: r.person_id, role: r.role, scope: scopeOf(r), definitionVersion: r.definition_version, grantedBy: r.granted_by, approvedBy: r.approved_by,
  approvalId: r.approval_id, reason: r.reason, breakglass: r.breakglass, incidentRef: r.incident_id, setupBootstrap: r.setup_bootstrap, validFrom: req(r.valid_from),
  validUntil: iso(r.valid_until), revokedAt: iso(r.revoked_at), revokedBy: r.revoked_by,
});

export const toConflict = (r: StaffConflictDeclarationRow) => ({
  id: r.id, staffPersonId: r.staff_person_id, party: r.conflict_person_id ? { kind: 'person' as const, id: r.conflict_person_id } : { kind: 'company' as const, id: r.conflict_company_id as string },
  reason: r.reason, declaredAt: req(r.declared_at), endedAt: iso(r.ended_at),
});

export const toApproval = (r: SecondPersonApprovalRow) => ({
  id: r.id, action: r.action, scope: scopeOf(r), actionDigest: r.action_digest, reason: r.reason, requestedBy: r.requested_by, requestedAt: req(r.requested_at),
  requestExpiresAt: req(r.request_expires_at), status: r.status, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), expiresAt: iso(r.expires_at), declinedBy: r.declined_by,
  declineReason: r.decline_reason, revokedAt: iso(r.revoked_at), consumedAt: iso(r.consumed_at), revision: r.revision,
});

export const toAuditEvent = (r: AdminAuditEventRow) => ({
  id: r.id, sequence: Number(r.sequence), occurredAt: req(r.occurred_at), actorPersonId: r.actor_person_id, actorRole: r.actor_role, scope: scopeOf(r), permission: r.permission,
  sessionElevationId: r.session_elevation_id, breakglass: r.breakglass, caseId: r.case_id, secondApproverPersonId: r.second_approver_person_id, approvalId: r.approval_id,
  approvalDigest: r.approval_digest, action: r.action, objectType: r.object_type, objectId: r.object_id, objectRevisionBefore: r.object_revision_before,
  objectRevisionAfter: r.object_revision_after, beforeDigest: r.before_digest, afterDigest: r.after_digest, reasonCode: r.reason_code, reasonText: r.reason_text, outcome: r.outcome,
  requestId: r.request_id, retentionClass: r.retention_class,
});

export const toAccessLogEntry = (r: AccessLogEntryRow) => ({
  id: r.id, sequence: Number(r.sequence), readAt: req(r.read_at), actorPersonId: r.actor_person_id, grantId: r.grant_id, caseRef: { kind: r.case_kind, id: r.case_id }, kind: r.kind,
  objectType: r.object_type, objectId: r.object_id, fieldsHash: r.fields_hash,
});

export function toCaseGrant(r: CaseAccessGrantRow, now: Date) {
  const expiresAt = iso(r.expires_at);
  return {
    id: r.id, supportCaseId: r.support_case_id, hubId: r.hub_id, requestedBy: r.requested_by, requestedAt: req(r.requested_at), objectSelector: { type: r.object_type, ids: [...r.object_ids].sort() },
    projectionClass: r.projection_class, excludedFieldClasses: [...r.excluded_field_classes].sort(), purpose: r.purpose, legalExceptionRef: r.legal_exception_ref, requestDigest: r.request_digest,
    status: r.status, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), expiresAt, deniedBy: r.denied_by, revokedAt: iso(r.revoked_at), revokedBy: r.revoked_by,
    revokeReason: r.revoke_reason, active: r.status === 'approved' && r.expires_at !== null && new Date(r.expires_at).getTime() > now.getTime(),
  };
}

export const toIncident = (r: IncidentRow) => ({
  id: r.id, scope: scopeOf(r), kind: r.kind, severity: r.severity, title: r.title, status: r.status, openedBy: r.opened_by, openedAt: req(r.opened_at), closedAt: iso(r.closed_at),
});

/** Staff view of a report: what was reported against which clause; the reporter's identity stays out. */
export const toReport = (r: ModerationReportRow) => ({ id: r.id, hubId: r.hub_id, targetKind: r.target_kind, targetId: r.target_id, clauseCode: r.clause_code, text: r.text, createdAt: req(r.created_at) });
/** The reporter's own receipt. */
export const toOwnReport = (r: ModerationReportRow) => ({ id: r.id, hubId: r.hub_id, targetKind: r.target_kind, targetId: r.target_id, clauseCode: r.clause_code, createdAt: req(r.created_at) });

export const toModerationCase = (r: ModerationCaseRow) => ({
  id: r.id, hubId: r.hub_id, targetKind: r.target_kind, targetId: r.target_id,
  subject: r.subject_person_id ? { kind: 'person' as const, id: r.subject_person_id } : r.subject_company_id ? { kind: 'company' as const, id: r.subject_company_id } : null,
  reportCount: r.report_ids.length, clauseCodes: r.clause_codes, status: r.status, emergencyHold: r.emergency_hold, decision: r.decision, decisionReason: r.decision_reason,
  decidedBy: r.decided_by, decidedAt: iso(r.decided_at), openedBy: r.opened_by, openedAt: req(r.opened_at), revision: r.revision,
});

export const toSanction = (r: SanctionRow) => ({
  id: r.id, hubId: r.hub_id, subject: r.subject_person_id ? { kind: 'person' as const, id: r.subject_person_id } : { kind: 'company' as const, id: r.subject_company_id as string },
  level: r.level, featureScope: r.feature_scope, startsAt: req(r.starts_at), endsAt: iso(r.ends_at), moderationCaseId: r.moderation_case_id, decidedBy: r.decided_by,
  secondApprovalId: r.second_approval_id, reason: r.reason, liftedAt: iso(r.lifted_at), liftedBy: r.lifted_by,
});

export const toAppeal = (r: AppealRow) => ({
  id: r.id, hubId: r.hub_id, subjectKind: r.subject_kind, subjectId: r.subject_id, appellantPersonId: r.appellant_person_id, appellantCompanyId: r.appellant_company_id, reason: r.reason,
  originalDecidedBy: r.original_decided_by, status: r.status, decidedBy: r.decided_by, decidedAt: iso(r.decided_at), decisionReason: r.decision_reason, filedAt: req(r.filed_at),
});

export const toFlag = (r: FeatureFlagRow) => ({
  id: r.id, key: r.key, scope: scopeOf(r), value: r.value, description: r.description, declaredEffect: r.declared_effect, ownerPersonId: r.owner_person_id, expiresAt: req(r.expires_at),
  changedBy: r.changed_by, revision: r.revision, updatedAt: req(r.updated_at),
});
