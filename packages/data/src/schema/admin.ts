import type { ColumnType, Generated, Selectable } from 'kysely';
import { columnsOf, type GeneratedTimestamp, type GeneratedUuid, type TableColumns, type Timestamp } from './index.js';

/**
 * Administration module (DATA-002, packages/data/migrations/admin): scoped staff roles (platform, node or hub), conflict
 * declarations, second-person approvals, the append-only mutation audit and access log, support
 * cases with case access grants, moderation, sanctions, appeals, feature flags, maintenance windows, incidents and kill
 * switches. Staff writes go only through the SECURITY DEFINER commands wrapped by `repositories/admin.ts`; the runtime
 * role reads under FORCE row-level security and may only INSERT audit and access-log rows. Staff commands need a live
 * elevation from BE-004's `session_elevation` (schema/identity.ts).
 */
type GeneratedInt = Generated<number>;
type Json<T> = ColumnType<T, string, string>;
/** `bigint` arrives from pg as a string. */
type BigintText = ColumnType<string, string | bigint, string | bigint>;
/** `interval` arrives from pg as a postgres-interval object; write it as text ('2 hours'). */
type IntervalColumn = ColumnType<unknown, string, string>;

export type StaffRole =
  | 'platform-owner' | 'staff-admin' | 'editor-in-chief' | 'editor' | 'moderator' | 'trust-reviewer' | 'support-agent' | 'support-lead'
  | 'commercial-admin' | 'data-steward' | 'ops-engineer' | 'privacy-officer' | 'auditor' | 'hub-owner' | 'compliance-officer' | 'node-operator';
export type StaffScopeKind = 'platform' | 'node' | 'hub';
export type SodMode = 'reduced' | 'full';
export type ApprovalStatus = 'pending' | 'approved' | 'declined' | 'revoked' | 'consumed';
export type AuditOutcome = 'applied' | 'denied' | 'failed';
export type RetentionClass = 'audit_long' | 'audit_standard';
export type IncidentKind = 'security' | 'privacy_breach' | 'provider' | 'content' | 'availability';
export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4';
export type IncidentStatus = 'open' | 'mitigated' | 'resolved' | 'closed';
export type SupportCaseStatus = 'open' | 'triaged' | 'waiting_on_requester' | 'grant_requested' | 'in_progress' | 'resolved' | 'closed';
export type SupportPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ProjectionClass = 'diagnostic' | 'support_private_limited' | 'evidence';
export type CaseGrantStatus = 'requested' | 'approved' | 'denied' | 'revoked';
export type CaseGrantRevokeReason = 'requester_done' | 'staff_revoked' | 'case_closed' | 'role_revoked';
export type AccessLogKind = 'case_read' | 'dispute_evidence_read' | 'audit_read' | 'evidence_view';
export type ModerationCaseStatus = 'open' | 'in_review' | 'decided' | 'appealed' | 'appeal_decided' | 'closed';
export type ModerationDecision = 'no_action' | 'warning' | 'content_removed' | 'content_restored' | 'sanction';
export type AppealSubjectKind =
  | 'sanction' | 'moderation_case' | 'verification_check' | 'review' | 'screening_result' | 'confirmation_response'
  | 'timeliness_observation' | 'performance_observation' | 'passport_credential' | 'recommendation'
  /** REP-001 (packages/data/migrations/reputation) adds automated limitations to the appeal subjects. */
  | 'automated_limitation';
export type AppealStatus = 'submitted' | 'in_review' | 'upheld' | 'overturned' | 'partially_overturned' | 'withdrawn';
export type FlagEffect = 'ui' | 'behaviour' | 'content' | 'operations';
export type KillSwitchScopeKind =
  | 'node' | 'hub_agent_dispatch' | 'agent_module' | 'agent_capability' | 'agent_action' | 'agent_extension' | 'external_agent_api'
  | 'provider_connection' | 'model_job' | 'pipeline' | 'outbound_messages';

export interface AdminNodeTable { id: GeneratedUuid; label: string; created_at: GeneratedTimestamp }
export interface StaffRoleDefinitionVersionTable {
  id: GeneratedUuid; role: StaffRole; version: number; scopes: StaffScopeKind[]; permissions: string[]; credit_cap_minor: BigintText | null; grant_max_hours: number;
  sod_conflicts: ColumnType<StaffRole[], StaffRole[] | undefined, StaffRole[]>; sod_mode: SodMode; released_by: string | null; released_at: GeneratedTimestamp;
}
export interface IncidentTable {
  id: GeneratedUuid; scope_kind: 'node' | 'hub'; node_id: string | null; hub_id: string | null; kind: IncidentKind; severity: IncidentSeverity; title: string;
  status: Generated<IncidentStatus>; linked_actions: ColumnType<unknown[], string | undefined, string>; breach_authority: string | null; notification_deadline: Timestamp | null;
  notified_at: Timestamp | null; post_review_ref: string | null; opened_by: string; opened_at: GeneratedTimestamp; closed_by: string | null; closed_at: Timestamp | null;
  revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface SecondPersonApprovalTable {
  id: GeneratedUuid; action: string; scope_kind: StaffScopeKind; node_id: string | null; hub_id: string | null; action_digest: string; reason: string; requested_by: string;
  requested_at: GeneratedTimestamp; request_expires_at: GeneratedTimestamp; status: Generated<ApprovalStatus>; approved_by: string | null; approved_at: Timestamp | null;
  expires_at: Timestamp | null; declined_by: string | null; decline_reason: string | null; revoked_at: Timestamp | null; revoked_by: string | null; consumed_at: Timestamp | null;
  consumed_ref: string | null; revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface StaffRoleAssignmentTable {
  id: GeneratedUuid; person_id: string; role: StaffRole; scope_kind: StaffScopeKind; node_id: string | null; hub_id: string | null; definition_version: number;
  granted_by: string | null; approved_by: string | null; approval_id: string | null; reason: string; breakglass: Generated<boolean>; incident_id: string | null;
  setup_bootstrap: Generated<boolean>; valid_from: GeneratedTimestamp; valid_until: Timestamp | null; revoked_at: Timestamp | null; revoked_by: string | null;
  revoke_reason: string | null; created_at: GeneratedTimestamp;
}
export interface StaffConflictDeclarationTable {
  id: GeneratedUuid; staff_person_id: string; conflict_person_id: string | null; conflict_company_id: string | null; reason: string; declared_at: GeneratedTimestamp; ended_at: Timestamp | null;
}
export interface AdminSequenceTable { name: 'admin_audit_event' | 'access_log_entry'; last_value: BigintText }
export interface AdminAuditEventTable {
  id: GeneratedUuid; sequence: ColumnType<string, never, never>; occurred_at: GeneratedTimestamp; actor_person_id: string; actor_role: StaffRole; scope_kind: StaffScopeKind;
  node_id: string | null; hub_id: string | null; permission: string; session_elevation_id: string; breakglass: Generated<boolean>; case_id: string | null;
  second_approver_person_id: string | null; approval_id: string | null; approval_digest: string | null; action: string; object_type: string; object_id: string;
  object_revision_before: number | null; object_revision_after: number | null; before_digest: string | null; after_digest: string | null; reason_code: string;
  reason_text: string; outcome: AuditOutcome; request_id: string; client_fingerprint_hash: string | null; retention_class: Generated<RetentionClass>;
}
export interface SupportCaseTable {
  id: GeneratedUuid; hub_id: string; number: ColumnType<string, never, never>; requester_person_id: string | null; external_source_subject_id: string | null; opened_by: string; subject_person_id: string | null;
  subject_company_id: string | null; category: string; summary: string; status: Generated<SupportCaseStatus>; priority: Generated<SupportPriority>; assigned_to: string | null;
  opened_at: GeneratedTimestamp; resolved_at: Timestamp | null; closed_at: Timestamp | null; closed_by: string | null; resolution_code: string | null;
  revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface SupportCaseNoteTable {
  id: GeneratedUuid; support_case_id: string; author_person_id: string; body: string; visibility: 'internal' | 'requester'; created_at: GeneratedTimestamp;
}
export interface CaseAccessGrantTable {
  id: GeneratedUuid; support_case_id: string; hub_id: string; requested_by: string; requested_at: GeneratedTimestamp; object_type: string; object_ids: string[];
  projection_class: ProjectionClass; excluded_field_classes: ColumnType<string[], string[] | undefined, string[]>; purpose: string; expires_in: IntervalColumn;
  legal_exception_ref: string | null; request_digest: string; status: Generated<CaseGrantStatus>; approved_by: string | null; approved_at: Timestamp | null;
  expires_at: Timestamp | null; denied_by: string | null; revoked_at: Timestamp | null; revoked_by: string | null; revoke_reason: CaseGrantRevokeReason | null;
  revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface AccessLogEntryTable {
  id: GeneratedUuid; sequence: ColumnType<string, never, never>; read_at: GeneratedTimestamp; actor_person_id: string; grant_id: string; hub_id: string;
  case_kind: Generated<'support_case' | 'dispute_case'>; case_id: string; kind: AccessLogKind; object_type: string; object_id: string; fields_hash: string;
}
export interface ModerationReportTable {
  id: GeneratedUuid; hub_id: string; reporter_person_id: string; target_kind: string; target_id: string; clause_code: string; text: string | null; created_at: GeneratedTimestamp;
}
export interface ModerationCaseTable {
  id: GeneratedUuid; hub_id: string; target_kind: string; target_id: string; subject_person_id: string | null; subject_company_id: string | null;
  report_ids: ColumnType<string[], string[] | undefined, string[]>; clause_codes: string[]; status: Generated<ModerationCaseStatus>; assigned_to: string | null;
  emergency_hold: Generated<boolean>; decision: ModerationDecision | null; decision_reason: string | null; decided_by: string | null; decided_at: Timestamp | null;
  opened_by: string; opened_at: GeneratedTimestamp; revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface SanctionTable {
  id: GeneratedUuid; hub_id: string; subject_person_id: string | null; subject_company_id: string | null; level: number; feature_scope: string; starts_at: GeneratedTimestamp;
  ends_at: Timestamp | null; moderation_case_id: string; decided_by: string; second_approval_id: string | null; reason: string; lifted_at: Timestamp | null;
  lifted_by: string | null; lift_reason: string | null; created_at: GeneratedTimestamp;
}
export interface AppealTable {
  id: GeneratedUuid; hub_id: string; subject_kind: AppealSubjectKind; subject_id: string; appellant_person_id: string; appellant_company_id: string | null; reason: string;
  original_decided_by: string; status: Generated<AppealStatus>; decided_by: string | null; decided_at: Timestamp | null; decision_reason: string | null;
  filed_at: GeneratedTimestamp; revision: GeneratedInt; updated_at: GeneratedTimestamp;
}
export interface FeatureFlagTable {
  id: GeneratedUuid; key: string; scope_kind: 'node' | 'hub'; node_id: string | null; hub_id: string | null; value: Json<unknown>; description: string; declared_effect: FlagEffect;
  owner_person_id: string; expires_at: Timestamp; changed_by: string; revision: GeneratedInt; created_at: GeneratedTimestamp; updated_at: GeneratedTimestamp;
}
export interface MaintenanceWindowTable {
  id: GeneratedUuid; scope_kind: 'node' | 'hub'; node_id: string | null; hub_id: string | null; starts_at: Timestamp; ends_at: Timestamp; reason: string; read_only: Generated<boolean>;
  created_by: string; cancelled_at: Timestamp | null; cancelled_by: string | null; created_at: GeneratedTimestamp;
}
export interface KillSwitchTable {
  id: GeneratedUuid; scope_kind: KillSwitchScopeKind; node_id: string | null; hub_id: string | null; module_key: string | null; action: string | null; extension_id: string | null;
  connection_id: string | null; job: string | null; pipeline_id: string | null; capability_id: string | null; state: Generated<'engaged' | 'released'>; engaged_by: string; engaged_at: GeneratedTimestamp;
  reason: string; incident_id: string | null; released_by: string | null; released_at: Timestamp | null; release_approval_id: string | null; incident_note: string | null;
  revision: GeneratedInt; updated_at: GeneratedTimestamp;
}

export interface AdminDatabase {
  support_external_source_subject: {
    id: GeneratedUuid; source_field_id: string; source_digest: string; action: 'correction' | 'erasure' | 'objection';
    proposed_value_digest: string; country: string; method: 'signed_statement' | 'record_control' | 'verified_representative';
    evidence_digest: string; attested_by: string; created_at: GeneratedTimestamp;
  };
  admin_node: AdminNodeTable;
  staff_role_definition_version: StaffRoleDefinitionVersionTable;
  incident: IncidentTable;
  second_person_approval: SecondPersonApprovalTable;
  staff_role_assignment: StaffRoleAssignmentTable;
  staff_conflict_declaration: StaffConflictDeclarationTable;
  admin_sequence: AdminSequenceTable;
  admin_audit_event: AdminAuditEventTable;
  support_case: SupportCaseTable;
  support_case_note: SupportCaseNoteTable;
  case_access_grant: CaseAccessGrantTable;
  access_log_entry: AccessLogEntryTable;
  moderation_report: ModerationReportTable;
  moderation_case: ModerationCaseTable;
  sanction: SanctionTable;
  appeal: AppealTable;
  feature_flag: FeatureFlagTable;
  maintenance_window: MaintenanceWindowTable;
  kill_switch: KillSwitchTable;
}

declare module './index.js' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- merges the module's tables into Database
  interface Database extends AdminDatabase {}
}

export type StaffRoleDefinitionRow = Selectable<StaffRoleDefinitionVersionTable>;
export type StaffRoleAssignmentRow = Selectable<StaffRoleAssignmentTable>;
export type SecondPersonApprovalRow = Selectable<SecondPersonApprovalTable>;
export type StaffConflictDeclarationRow = Selectable<StaffConflictDeclarationTable>;
export type AdminAuditEventRow = Selectable<AdminAuditEventTable>;
export type IncidentRow = Selectable<IncidentTable>;
export type SupportCaseRow = Selectable<SupportCaseTable>;
export type SupportCaseNoteRow = Selectable<SupportCaseNoteTable>;
export type CaseAccessGrantRow = Selectable<CaseAccessGrantTable>;
export type AccessLogEntryRow = Selectable<AccessLogEntryTable>;
export type ModerationReportRow = Selectable<ModerationReportTable>;
export type ModerationCaseRow = Selectable<ModerationCaseTable>;
export type SanctionRow = Selectable<SanctionTable>;
export type AppealRow = Selectable<AppealTable>;
export type FeatureFlagRow = Selectable<FeatureFlagTable>;
export type MaintenanceWindowRow = Selectable<MaintenanceWindowTable>;
export type KillSwitchRow = Selectable<KillSwitchTable>;

const columns = columnsOf<AdminDatabase>();
export const TABLE_COLUMNS: TableColumns<AdminDatabase> = {
  admin_node: columns('admin_node', ['id', 'label', 'created_at']),
  staff_role_definition_version: columns('staff_role_definition_version', ['id', 'role', 'version', 'scopes', 'permissions', 'credit_cap_minor', 'grant_max_hours', 'sod_conflicts', 'sod_mode', 'released_by', 'released_at']),
  incident: columns('incident', ['id', 'scope_kind', 'node_id', 'hub_id', 'kind', 'severity', 'title', 'status', 'linked_actions', 'breach_authority', 'notification_deadline', 'notified_at',
    'post_review_ref', 'opened_by', 'opened_at', 'closed_by', 'closed_at', 'revision', 'updated_at']),
  second_person_approval: columns('second_person_approval', ['id', 'action', 'scope_kind', 'node_id', 'hub_id', 'action_digest', 'reason', 'requested_by', 'requested_at', 'request_expires_at',
    'status', 'approved_by', 'approved_at', 'expires_at', 'declined_by', 'decline_reason', 'revoked_at', 'revoked_by', 'consumed_at', 'consumed_ref', 'revision', 'updated_at']),
  staff_role_assignment: columns('staff_role_assignment', ['id', 'person_id', 'role', 'scope_kind', 'node_id', 'hub_id', 'definition_version', 'granted_by', 'approved_by', 'approval_id',
    'reason', 'breakglass', 'incident_id', 'setup_bootstrap', 'valid_from', 'valid_until', 'revoked_at', 'revoked_by', 'revoke_reason', 'created_at']),
  staff_conflict_declaration: columns('staff_conflict_declaration', ['id', 'staff_person_id', 'conflict_person_id', 'conflict_company_id', 'reason', 'declared_at', 'ended_at']),
  admin_sequence: columns('admin_sequence', ['name', 'last_value']),
  admin_audit_event: columns('admin_audit_event', ['id', 'sequence', 'occurred_at', 'actor_person_id', 'actor_role', 'scope_kind', 'node_id', 'hub_id', 'permission', 'session_elevation_id',
    'breakglass', 'case_id', 'second_approver_person_id', 'approval_id', 'approval_digest', 'action', 'object_type', 'object_id', 'object_revision_before', 'object_revision_after',
    'before_digest', 'after_digest', 'reason_code', 'reason_text', 'outcome', 'request_id', 'client_fingerprint_hash', 'retention_class']),
  support_external_source_subject: columns('support_external_source_subject', ['id', 'source_field_id', 'source_digest', 'action', 'proposed_value_digest', 'country', 'method', 'evidence_digest', 'attested_by', 'created_at']),
  support_case: columns('support_case', ['external_source_subject_id', 'id', 'hub_id', 'number', 'requester_person_id', 'opened_by', 'subject_person_id', 'subject_company_id', 'category', 'summary', 'status', 'priority',
    'assigned_to', 'opened_at', 'resolved_at', 'closed_at', 'closed_by', 'resolution_code', 'revision', 'updated_at']),
  support_case_note: columns('support_case_note', ['id', 'support_case_id', 'author_person_id', 'body', 'visibility', 'created_at']),
  case_access_grant: columns('case_access_grant', ['id', 'support_case_id', 'hub_id', 'requested_by', 'requested_at', 'object_type', 'object_ids', 'projection_class', 'excluded_field_classes',
    'purpose', 'expires_in', 'legal_exception_ref', 'request_digest', 'status', 'approved_by', 'approved_at', 'expires_at', 'denied_by', 'revoked_at', 'revoked_by', 'revoke_reason',
    'revision', 'updated_at']),
  access_log_entry: columns('access_log_entry', ['id', 'sequence', 'read_at', 'actor_person_id', 'grant_id', 'hub_id', 'case_kind', 'case_id', 'kind', 'object_type', 'object_id', 'fields_hash']),
  moderation_report: columns('moderation_report', ['id', 'hub_id', 'reporter_person_id', 'target_kind', 'target_id', 'clause_code', 'text', 'created_at']),
  moderation_case: columns('moderation_case', ['id', 'hub_id', 'target_kind', 'target_id', 'subject_person_id', 'subject_company_id', 'report_ids', 'clause_codes', 'status', 'assigned_to',
    'emergency_hold', 'decision', 'decision_reason', 'decided_by', 'decided_at', 'opened_by', 'opened_at', 'revision', 'updated_at']),
  sanction: columns('sanction', ['id', 'hub_id', 'subject_person_id', 'subject_company_id', 'level', 'feature_scope', 'starts_at', 'ends_at', 'moderation_case_id', 'decided_by',
    'second_approval_id', 'reason', 'lifted_at', 'lifted_by', 'lift_reason', 'created_at']),
  appeal: columns('appeal', ['id', 'hub_id', 'subject_kind', 'subject_id', 'appellant_person_id', 'appellant_company_id', 'reason', 'original_decided_by', 'status', 'decided_by',
    'decided_at', 'decision_reason', 'filed_at', 'revision', 'updated_at']),
  feature_flag: columns('feature_flag', ['id', 'key', 'scope_kind', 'node_id', 'hub_id', 'value', 'description', 'declared_effect', 'owner_person_id', 'expires_at', 'changed_by',
    'revision', 'created_at', 'updated_at']),
  maintenance_window: columns('maintenance_window', ['id', 'scope_kind', 'node_id', 'hub_id', 'starts_at', 'ends_at', 'reason', 'read_only', 'created_by', 'cancelled_at', 'cancelled_by', 'created_at']),
  kill_switch: columns('kill_switch', ['id', 'scope_kind', 'node_id', 'hub_id', 'module_key', 'action', 'extension_id', 'connection_id', 'job', 'pipeline_id', 'capability_id', 'state', 'engaged_by',
    'engaged_at', 'reason', 'incident_id', 'released_by', 'released_at', 'release_approval_id', 'incident_note', 'revision', 'updated_at']),
};
