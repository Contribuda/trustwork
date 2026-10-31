import { z } from 'zod';
import {
  CONSOLE_SECOND_PERSON_ACTIONS, consoleCommand, type ConsoleSecondPersonAction, FORBIDDEN_CONTROL_WORDS, HubStaffRoleSchema, ProjectionClassSchema, ShortTextSchema,
} from '../../deps/contracts.js';

/**
 * Request schemas of the administration API (ADM-001). Every command is a console command (`consoleCommand` of the
 * frozen HUBC-000 contract: contract version, idempotency key equal to the `Idempotency-Key` header, a staff reason)
 * plus an optional machine reason code; the server adds the actor, the elevated session and the audit record.
 * Strict objects reject unknown fields, so no command can smuggle a score, a rank, a position, a badge or a weight
 * (tests/admin/no-ranking-controls.test.ts walks every schema below).
 */
const Uuid = z.uuid();
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const command = <T extends z.ZodRawShape>(shape: T) => consoleCommand({ reasonCode: ReasonCode.optional(), ...shape });

export const AdminScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({ kind: z.literal('node'), nodeId: Uuid }),
  z.strictObject({ kind: z.literal('hub'), hubId: Uuid }),
]);
const Party = z.strictObject({ kind: z.enum(['person', 'company']), id: Uuid });
const MAX_ROLE_SECONDS = 400 * 24 * 3600;
const BREAKGLASS_SECONDS = 12 * 3600;
const APPROVAL_SECONDS = 72 * 3600;

/* ---------- Staff ---------- */

export const AssignRoleCommandSchema = command({
  personId: Uuid, role: HubStaffRoleSchema, scope: AdminScopeSchema, definitionVersion: z.int().min(1),
  validForSeconds: z.int().min(60).max(MAX_ROLE_SECONDS).nullable().optional(), approvalId: Uuid.optional(),
});
export const BreakglassCommandSchema = command({
  personId: Uuid, role: HubStaffRoleSchema, scope: AdminScopeSchema, definitionVersion: z.int().min(1), incidentId: Uuid,
  validForSeconds: z.int().min(60).max(BREAKGLASS_SECONDS), approvalId: Uuid,
});
export const PlainCommandSchema = command({});
export const DeclareConflictCommandSchema = command({ party: Party });
export const OpenIncidentCommandSchema = command({
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('node'), nodeId: Uuid }), z.strictObject({ kind: z.literal('hub'), hubId: Uuid })]),
  kind: z.enum(['security', 'privacy_breach', 'provider', 'content', 'availability']), severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']), title: z.string().min(1).max(200),
});

/* ---------- Second-person approvals ---------- */

const KNOWN_ACTIONS = ['staff.assign_sensitive_role', 'staff.grant_breakglass', 'moderation.apply_sanction_l4'] as const;
type OtherAction = Exclude<ConsoleSecondPersonAction, (typeof KNOWN_ACTIONS)[number]>;
const OTHER_ACTIONS = CONSOLE_SECOND_PERSON_ACTIONS.filter((a): a is OtherAction => !(KNOWN_ACTIONS as readonly string[]).includes(a)) as [OtherAction, ...OtherAction[]];
/**
 * What the second person is asked to approve. For the actions this module executes the server computes the digest
 * from the described action itself (the same trustwork-digest-1 the database recomputes at execution), so nobody
 * approves bytes they cannot read. Actions executed by other modules carry the digest their owning module computes.
 */
export const ApprovalSubjectSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('staff.assign_sensitive_role'), personId: Uuid, role: HubStaffRoleSchema, scope: AdminScopeSchema, definitionVersion: z.int().min(1),
    validForSeconds: z.int().min(60).max(MAX_ROLE_SECONDS).nullable().optional(),
  }),
  z.strictObject({
    action: z.literal('staff.grant_breakglass'), personId: Uuid, role: HubStaffRoleSchema, scope: AdminScopeSchema, definitionVersion: z.int().min(1), incidentId: Uuid,
    validForSeconds: z.int().min(60).max(BREAKGLASS_SECONDS),
  }),
  z.strictObject({
    action: z.literal('moderation.apply_sanction_l4'), moderationCaseId: Uuid, featureScope: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    durationSeconds: z.int().min(60).nullable(),
  }),
  z.strictObject({ action: z.enum(OTHER_ACTIONS), scope: AdminScopeSchema, actionDigest: z.string().regex(/^[a-f0-9]{64}$/) }),
]);
export type ApprovalSubject = z.infer<typeof ApprovalSubjectSchema>;
export const RequestApprovalCommandSchema = command({ subject: ApprovalSubjectSchema });
/** The approver restates the digest they reviewed; an approval lasts at most 72 hours. */
export const ApproveCommandSchema = command({ actionDigest: z.string().regex(/^[a-f0-9]{64}$/), validForSeconds: z.int().min(60).max(APPROVAL_SECONDS).optional() });

/* ---------- Case access grants (no impersonation: a scoped, logged read right, never a session) ---------- */

export const RequestCaseGrantCommandSchema = command({
  supportCaseId: Uuid, objectType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), objectIds: z.array(Uuid).min(1).max(100), projectionClass: ProjectionClassSchema,
  purpose: ShortTextSchema, expiresInSeconds: z.int().min(60).max(APPROVAL_SECONDS), legalExceptionRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/).nullable().optional(),
});
export const DecideCaseGrantCommandSchema = command({ decision: z.enum(['approve', 'deny']), requestDigest: z.string().regex(/^[a-f0-9]{64}$/) });

/* ---------- Moderation, sanctions and appeals ---------- */

const ClauseCode = z.string().regex(/^[a-z][a-z0-9_.]{1,80}$/);
const TargetKind = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
/** Participant path: anyone signed in reports content of a hub against a published clause. */
export const ReportContentCommandSchema = z.strictObject({ hubId: Uuid, targetKind: TargetKind, targetId: Uuid, clauseCode: ClauseCode, text: z.string().min(1).max(4000).nullable().optional() });
export const OpenModerationCaseCommandSchema = command({
  hubId: Uuid, targetKind: TargetKind, targetId: Uuid, subject: Party.nullable().optional(), reportIds: z.array(Uuid).max(100).optional(), clauseCodes: z.array(ClauseCode).min(1).max(20),
  emergencyHold: z.boolean().optional(),
});
export const DecideModerationCaseCommandSchema = command({ decision: z.enum(['no_action', 'warning', 'content_removed', 'content_restored', 'sanction']) });
export const ApplySanctionCommandSchema = command({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), featureScope: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), durationSeconds: z.int().min(60).nullable(),
  approvalId: Uuid.optional(),
});
/** Participant path: the subject appeals a sanction or a moderation decision about them. */
export const FileAppealCommandSchema = z.strictObject({ subjectKind: z.enum(['sanction', 'moderation_case']), subjectId: Uuid, reason: z.string().min(1).max(4000) });
export const DecideAppealCommandSchema = command({ decision: z.enum(['upheld', 'overturned', 'partially_overturned']) });

/* ---------- Feature flags (never access, never ranking) ---------- */

const FlagValue = z.union([z.boolean(), z.int().min(-1_000_000).max(1_000_000), z.string().regex(/^[a-z][a-z0-9_]{0,40}$/)]);
export const SetFlagCommandSchema = command({
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('node'), nodeId: Uuid }), z.strictObject({ kind: z.literal('hub'), hubId: Uuid })]),
  key: z.string().regex(/^[a-z][a-z0-9_.]{2,80}$/), value: FlagValue, description: z.string().min(1).max(500), declaredEffect: z.enum(['ui', 'behaviour', 'content', 'operations']),
  expiresAt: z.iso.datetime({ offset: false }),
}).superRefine((c, ctx) => {
  // The database refuses these words in keys too (plus access words); values and descriptions are checked here.
  for (const [path, text] of [['key', c.key], ['description', c.description], ['value', typeof c.value === 'string' ? c.value : '']] as const) {
    if (FORBIDDEN_CONTROL_WORDS.test(text)) ctx.addIssue({ code: 'custom', path: [path], message: 'flags never control ranking, scores, positions or badges' });
  }
});

/* ---------- Queries ---------- */

export const UuidParams = z.strictObject({ id: Uuid });
export const TargetQuerySchema = z.strictObject({ nodeId: Uuid.optional(), hubId: Uuid.optional() }).refine((q) => !(q.nodeId && q.hubId), { message: 'one of nodeId or hubId' });
export const AssignmentsQuerySchema = z.strictObject({ personId: Uuid.optional(), activeOnly: z.enum(['true', 'false']).optional() });
export const ApprovalsQuerySchema = z.strictObject({ hubId: Uuid.optional() });
export const AuditQuerySchema = z.strictObject({
  objectType: z.string().min(1).max(64).optional(), objectId: Uuid.optional(), actorPersonId: Uuid.optional(), hubId: Uuid.optional(),
  afterSequence: z.string().regex(/^\d{1,18}$/).optional(), limit: z.string().regex(/^\d{1,3}$/).optional(),
});
export const AccessLogQuerySchema = z.strictObject({ grantId: Uuid.optional(), objectId: Uuid.optional() });
export const HubQuerySchema = z.strictObject({ hubId: Uuid });
export const CoverageQuerySchema = z.strictObject({ objectType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), objectId: Uuid });
export const FlagsQuerySchema = z.strictObject({ hubId: Uuid.optional(), nodeId: Uuid.optional() });

/** Every request schema of the module (body, query and params), for the "no ranking control" walk. */
export const ADMIN_REQUEST_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  AssignRoleCommandSchema, BreakglassCommandSchema, PlainCommandSchema, DeclareConflictCommandSchema, OpenIncidentCommandSchema, RequestApprovalCommandSchema, ApproveCommandSchema,
  RequestCaseGrantCommandSchema, DecideCaseGrantCommandSchema, ReportContentCommandSchema, OpenModerationCaseCommandSchema, DecideModerationCaseCommandSchema, ApplySanctionCommandSchema,
  FileAppealCommandSchema, DecideAppealCommandSchema, SetFlagCommandSchema, UuidParams, TargetQuerySchema, AssignmentsQuerySchema, ApprovalsQuerySchema, AuditQuerySchema,
  AccessLogQuerySchema, HubQuerySchema, CoverageQuerySchema, FlagsQuerySchema,
};
