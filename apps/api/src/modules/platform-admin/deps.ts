/**
 * Relative re-exports of the DATA-002 administration slice (ADM-001). The module imports the repository and schema
 * files directly so the shared package entries (`packages/data/src/index.ts`) stay untouched; adding them to that
 * barrel is integrator bookkeeping. The contracts (admin.ts, hub.ts) come through `deps/contracts.ts`.
 */
export {
  adminAudit, adminDigests, adminSetup, appeals, approvals, caseGrants, featureFlags, incidents, moderation, staffAssignments, staffConflicts, staffRoleDefinitions,
  supportCases, type CommandContext, type PartyRef, type StaffScope,
} from '../../../../../packages/data/src/repositories/admin.js';
export type {
  AccessLogEntryRow, AdminAuditEventRow, AppealRow, CaseAccessGrantRow, FeatureFlagRow, FlagEffect, IncidentRow, ModerationCaseRow, ModerationDecision, ModerationReportRow,
  SanctionRow, SecondPersonApprovalRow, StaffConflictDeclarationRow, StaffRole, StaffRoleAssignmentRow, StaffRoleDefinitionRow,
} from '../../../../../packages/data/src/schema/admin.js';
