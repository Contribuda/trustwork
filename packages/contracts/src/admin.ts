import { z } from 'zod';
import { DigestSchema, Sha256HexSchema } from './common/digest-schema.js';
import { IdSchema, RequestIdSchema, RevisionSchema, ShortTextSchema, TimestampSchema } from './common/ids.js';
import { NonNegativeMinorUnitsSchema } from './common/money.js';

/** Permission vocabulary `admin.<domain>.<action>` frozen from the accepted ADM-000 capability map. */
export const ADMIN_PERMISSIONS = [
  'admin.assistant.reconcile', 'admin.assistant.run.inspect',
  'admin.audit.export', 'admin.audit.read', 'admin.audit.verify',
  'admin.claims.authority.decide', 'admin.claims.clarify', 'admin.claims.decide', 'admin.claims.policy.edit', 'admin.claims.read', 'admin.claims.revoke',
  'admin.commerce.acceptance.read', 'admin.commerce.credit.issue', 'admin.commerce.entitlement.read', 'admin.commerce.offer.edit', 'admin.commerce.plan.activate',
  'admin.commerce.price.activate', 'admin.commerce.price.draft', 'admin.commerce.refund.policy', 'admin.commerce.usage.read',
  'admin.config.edit', 'admin.config.maintenance', 'admin.currency.edit', 'admin.flags.edit',
  'admin.incident.open', 'admin.incident.preserve', 'admin.incident.review',
  'admin.issues.correct', 'admin.issues.curate', 'admin.issues.read', 'admin.issues.release', 'admin.issues.render',
  'admin.jobs.retry',
  'admin.moderation.appeal.decide', 'admin.moderation.case.open', 'admin.moderation.decide', 'admin.moderation.emergency.freeze', 'admin.moderation.emergency.hold',
  'admin.moderation.read', 'admin.moderation.review.confirm',
  'admin.notifications.broadcast', 'admin.notifications.read', 'admin.notifications.template.edit',
  'admin.observability.read',
  'admin.people.consent.read', 'admin.people.consent.record', 'admin.people.flag', 'admin.people.portrait.licence',
  'admin.privacy.erasure.execute', 'admin.privacy.export', 'admin.privacy.hold', 'admin.privacy.request.read', 'admin.privacy.retention.edit',
  'admin.providers.budget.edit', 'admin.providers.egress.edit', 'admin.providers.kill', 'admin.providers.read', 'admin.providers.toggle',
  'admin.publications.correct', 'admin.publications.hold', 'admin.publications.links.edit', 'admin.publications.publish', 'admin.publications.read',
  'admin.publications.retract', 'admin.publications.review',
  'admin.retrieval.eval.read', 'admin.retrieval.generation.activate', 'admin.retrieval.generation.build', 'admin.retrieval.generation.taint',
  'admin.retrieval.quarantine', 'admin.retrieval.read', 'admin.retrieval.reindex',
  'admin.session.elevate',
  'admin.sources.dedupe.decide', 'admin.sources.import.activate', 'admin.sources.manage', 'admin.sources.read', 'admin.sources.takedown',
  'admin.staff.assign', 'admin.staff.breakglass', 'admin.staff.conflict.declare', 'admin.staff.read', 'admin.staff.revoke',
  'admin.support.case.close', 'admin.support.case.create', 'admin.support.diagnose', 'admin.support.grant.approve', 'admin.support.grant.request',
  'admin.support.notifications', 'admin.support.recovery.approve',
  'admin.taxonomy.edit', 'admin.taxonomy.read', 'admin.taxonomy.release',
  'admin.trust.evidence.decide', 'admin.trust.exclude', 'admin.trust.method.release',
  'admin.units.edit',
] as const;
export const AdminPermissionSchema = z.enum(ADMIN_PERMISSIONS);
export type AdminPermission = z.infer<typeof AdminPermissionSchema>;

export const STAFF_ROLES = [
  'platform-owner', 'staff-admin', 'editor-in-chief', 'editor', 'moderator', 'trust-reviewer', 'support-agent', 'support-lead',
  'commercial-admin', 'data-steward', 'ops-engineer', 'privacy-officer', 'auditor',
] as const;
export const StaffRoleIdSchema = z.enum(STAFF_ROLES);
export type StaffRoleId = z.infer<typeof StaffRoleIdSchema>;

/** `reduced` while staff < 5: only per-action actor != approver for the five A+2 actions; `full` evaluates hard role conflicts too. */
export const SodModeSchema = z.enum(['reduced', 'full']);
export type SodMode = z.infer<typeof SodModeSchema>;

/** The five actions that always need a second person (A+2), in every SoD mode. */
export const A_PLUS_2_ACTIONS = [
  'staff.assign_sensitive_role', 'commerce.activate_price_version', 'privacy.execute_erasure', 'moderation.apply_sanction_l4', 'providers.enable_non_fake', 'staff.switch_sod_mode',
] as const;
export const SecondPersonActionSchema = z.enum(A_PLUS_2_ACTIONS);
export type SecondPersonAction = z.infer<typeof SecondPersonActionSchema>;
export const SENSITIVE_STAFF_ROLES: readonly StaffRoleId[] = ['platform-owner', 'staff-admin', 'commercial-admin', 'privacy-officer'];

export const StaffRoleDefinitionSchema = z.strictObject({
  version: z.int().min(1),
  role: StaffRoleIdSchema,
  permissions: z.array(AdminPermissionSchema).min(1),
  caps: z.strictObject({ creditCapMinorUnits: NonNegativeMinorUnitsSchema.nullable(), grantMaxHours: z.int().min(1).max(72) }),
  sodConflicts: z.array(StaffRoleIdSchema),
  sodMode: SodModeSchema,
  releasedAt: TimestampSchema,
  releasedBy: IdSchema,
});
export type StaffRoleDefinition = z.infer<typeof StaffRoleDefinitionSchema>;

export const StaffRoleAssignmentSchema = z.strictObject({
  id: IdSchema,
  personId: IdSchema,
  role: StaffRoleIdSchema,
  scope: z.literal('platform'),
  definitionVersion: z.int().min(1),
  validFrom: TimestampSchema,
  validUntil: TimestampSchema.nullable(),
  grantedBy: IdSchema,
  approvedBy: IdSchema.nullable(),
  reason: ShortTextSchema,
  revokedAt: TimestampSchema.nullable(),
  revokedBy: IdSchema.nullable(),
}).refine((a) => !SENSITIVE_STAFF_ROLES.includes(a.role) || (a.approvedBy !== null && a.approvedBy !== a.grantedBy), {
  message: 'sensitive staff roles require a second approver distinct from the grantor',
  path: ['approvedBy'],
});
export type StaffRoleAssignment = z.infer<typeof StaffRoleAssignmentSchema>;

export const CASE_GRANT_MAX_HOURS = 72;
export const ProjectionClassSchema = z.enum(['diagnostic', 'support_private_limited', 'evidence']);
export type ProjectionClass = z.infer<typeof ProjectionClassSchema>;
export const ExcludedFieldClassSchema = z.enum(['negotiation_private', 'credentials', 'payment_refs']);
export const ALWAYS_EXCLUDED_FIELD_CLASSES = ['negotiation_private', 'credentials', 'payment_refs'] as const;

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;

/** Audited, time-boxed staff read on private customer objects; never a general staff right. */
export const CaseAccessGrantSchema = z.strictObject({
  id: IdSchema,
  supportCaseId: IdSchema,
  requestedBy: IdSchema,
  approvedBy: IdSchema,
  /** Digest of the approved request (object selector, projection class, purpose, expiry). */
  approvalDigest: DigestSchema,
  objectSelector: z.strictObject({ type: z.string().min(1).max(64), ids: z.array(IdSchema).min(1).max(100) }),
  projectionClass: ProjectionClassSchema,
  excludedFieldClasses: z.array(ExcludedFieldClassSchema),
  purpose: ShortTextSchema,
  requestedAt: TimestampSchema,
  approvedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  revokedBy: IdSchema.nullable(),
  legalExceptionRef: IdSchema.nullable(),
})
  .refine((g) => g.requestedBy !== g.approvedBy, { message: 'requester must differ from approver', path: ['approvedBy'] })
  .refine((g) => hours(g.approvedAt, g.expiresAt) > 0 && hours(g.approvedAt, g.expiresAt) <= CASE_GRANT_MAX_HOURS, {
    message: `grant must expire within ${CASE_GRANT_MAX_HOURS} hours of approval`,
    path: ['expiresAt'],
  })
  .refine((g) => ALWAYS_EXCLUDED_FIELD_CLASSES.every((cls) => g.excludedFieldClasses.includes(cls)), {
    message: 'negotiation_private, credentials and payment_refs are always excluded',
    path: ['excludedFieldClasses'],
  });
export type CaseAccessGrant = z.infer<typeof CaseAccessGrantSchema>;

export function caseGrantActive(grant: CaseAccessGrant, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && grant.revokedAt === null && Date.parse(grant.approvedAt) <= t && Date.parse(grant.expiresAt) > t;
}

/** Second-person approval bound to an exact action digest; any change of the action invalidates it. */
export const SecondPersonApprovalSchema = z.strictObject({
  id: IdSchema,
  action: SecondPersonActionSchema,
  actionDigest: DigestSchema,
  requestedBy: IdSchema,
  approvedBy: IdSchema,
  approvedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
}).refine((a) => a.requestedBy !== a.approvedBy, { message: 'actor must differ from approver', path: ['approvedBy'] });
export type SecondPersonApproval = z.infer<typeof SecondPersonApprovalSchema>;

export function requiresSecondApprover(action: string, mode: SodMode): boolean {
  // Both modes require A+2 for the five actions (and the mode switch itself); `full` adds hard role conflicts elsewhere.
  void mode;
  return (A_PLUS_2_ACTIONS as readonly string[]).includes(action);
}
export function approvalBindsAction(approval: SecondPersonApproval, action: SecondPersonAction, actionDigest: { value: string }, now: Date): boolean {
  const t = now.getTime();
  return Number.isFinite(t) && approval.revokedAt === null && approval.action === action && approval.actionDigest.value === actionDigest.value && Date.parse(approval.expiresAt) > t;
}

export const AdminAuditOutcomeSchema = z.enum(['applied', 'denied', 'failed']);
/** Append-only mutation audit with a monotonic sequence; before/after are digests, never payloads. Reads go to `AccessLogEntry`. */
export const AdminAuditEventSchema = z.strictObject({
  id: IdSchema,
  sequence: z.int().min(1),
  occurredAt: TimestampSchema,
  actorPersonId: IdSchema,
  actorRole: StaffRoleIdSchema,
  permission: AdminPermissionSchema,
  sessionElevationId: IdSchema,
  caseId: IdSchema.nullable(),
  secondApproverPersonId: IdSchema.nullable(),
  approvalDigest: DigestSchema.nullable(),
  action: z.string().min(1).max(100).regex(/^[a-z][A-Za-z0-9_.]*$/),
  objectType: z.string().min(1).max(64),
  objectId: IdSchema,
  objectRevisionBefore: RevisionSchema.nullable(),
  objectRevisionAfter: RevisionSchema.nullable(),
  beforeDigest: DigestSchema.nullable(),
  afterDigest: DigestSchema.nullable(),
  reasonCode: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/),
  /** Required free text for staff readability; its language is the UI language, not a contract concern. */
  reasonText: ShortTextSchema,
  outcome: AdminAuditOutcomeSchema,
  requestId: RequestIdSchema,
  clientFingerprintHash: Sha256HexSchema,
  retentionClass: z.enum(['audit_long', 'audit_standard']),
})
  .refine((e) => !(A_PLUS_2_ACTIONS as readonly string[]).includes(e.action) || e.outcome !== 'applied' || (e.secondApproverPersonId !== null && e.approvalDigest !== null), {
    message: 'applied A+2 actions record the second approver and approval digest',
    path: ['secondApproverPersonId'],
  })
  .refine((e) => e.secondApproverPersonId === null || e.secondApproverPersonId !== e.actorPersonId, { message: 'actor cannot be own approver', path: ['secondApproverPersonId'] });
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;

export const AccessLogEntrySchema = z.strictObject({
  id: IdSchema,
  sequence: z.int().min(1),
  readAt: TimestampSchema,
  actorPersonId: IdSchema,
  grantId: IdSchema,
  caseRef: z.strictObject({ kind: z.enum(['support_case', 'dispute_case']), id: IdSchema }),
  kind: z.enum(['case_read', 'dispute_evidence_read', 'audit_read', 'evidence_view']),
  objectType: z.string().min(1).max(64),
  objectId: IdSchema,
  fieldsHash: Sha256HexSchema,
});
export type AccessLogEntry = z.infer<typeof AccessLogEntrySchema>;

/** Audit sequence continuity: a gap means a removed row (anchor verification is a later control). */
export function auditSequenceContinuous(sequences: readonly number[]): boolean {
  return sequences.every((seq, index) => index === 0 || seq === sequences[index - 1]! + 1);
}
