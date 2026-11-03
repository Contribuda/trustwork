import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { SodModeSchema } from './admin.js';
import { BREAKGLASS_MAX_HOURS, consoleCommand, ConsolePermissionSchema, HubStaffRoleSchema, StaffScopeSchema } from './hub.js';

/**
 * ADM-004 staff lifecycle and access governance (docs/engine/hub-console/console-design.md, section 4.2). This file
 * grows with the package: part 1 holds the staff directory and the effective-access query, part 2 invitations, part 3
 * eligible roles with just-in-time activation and the role-change preview.
 *
 * Nothing here describes what a staff member does: no activity, sign-in times, counts of decisions, response times or
 * any other behaviour or productivity measure (a schema walk in tests/admin/staff-lifecycle checks the field names).
 */

/** One active role of a staff member as the directory shows it. */
export const StaffDirectoryRoleSchema = z.strictObject({
  assignmentId: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  validUntil: TimestampSchema.nullable(),
  breakglass: z.boolean(),
});
export type StaffDirectoryRole = z.infer<typeof StaffDirectoryRoleSchema>;

/**
 * A person who holds an active staff role covering the hub. Every staff member of the hub reads the names (approvals and
 * audit name who asked and who decided); roles and whether a second factor is enrolled are shown only to a reader with
 * `admin.staff.read` at the hub, and are `null` otherwise.
 */
export const StaffDirectoryEntrySchema = z.strictObject({
  personId: IdSchema,
  displayName: z.string().min(1).max(200),
  roles: z.array(StaffDirectoryRoleSchema).nullable(),
  secondFactor: z.enum(['enrolled', 'none']).nullable(),
});
export type StaffDirectoryEntry = z.infer<typeof StaffDirectoryEntrySchema>;

/** `GET /v1/admin/staff/directory?hubId=`: `detail` says whether roles and second-factor state are included. */
export const StaffDirectorySchema = z.strictObject({
  hubId: IdSchema,
  detail: z.boolean(),
  entries: z.array(StaffDirectoryEntrySchema),
});
export type StaffDirectory = z.infer<typeof StaffDirectorySchema>;

export const StaffDirectoryQuerySchema = z.strictObject({ hubId: IdSchema });

/**
 * `GET /v1/admin/staff/effective-access?personId=&hubId=`: what one staff member may do at the hub right now, from
 * the released role definitions and their active assignments (needs `admin.staff.read` at the hub). Permissions that
 * only break-glass grants carry are listed separately.
 */
export const EffectiveAccessSchema = z.strictObject({
  personId: IdSchema,
  hubId: IdSchema,
  roles: z.array(HubStaffRoleSchema),
  permissions: z.array(ConsolePermissionSchema),
  breakglassOnly: z.array(ConsolePermissionSchema),
});
export type EffectiveAccess = z.infer<typeof EffectiveAccessSchema>;

export const EffectiveAccessQuerySchema = z.strictObject({ personId: IdSchema, hubId: IdSchema });

/* ---------- Part 2: invitations ---------- */

const Uuid = z.uuid();
const InvitationScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('platform') }),
  z.strictObject({ kind: z.literal('node'), nodeId: Uuid }),
  z.strictObject({ kind: z.literal('hub'), hubId: Uuid }),
]);

/**
 * `POST /v1/admin/staff/invitations`: invite an e-mail address to one role at a scope, optionally for a limited time
 * (one hour to 366 days), with the console command's reason. A sensitive role asks a second person when the inviter
 * applies the accepted invitation.
 */
export const InviteStaffCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  email: z.string().trim().min(3).max(254).regex(/^[^@\s]+@[^@\s]+$/),
  role: HubStaffRoleSchema,
  scope: InvitationScopeSchema,
  definitionVersion: z.int().min(1),
  validForSeconds: z.int().min(3600).max(31_622_400).nullable(),
});
/** `POST /v1/me/staff-invitations/:id/respond`: the invitee accepts (with a second factor) or declines. */
export const RespondStaffInvitationSchema = z.strictObject({ accept: z.boolean() });

export const StaffInvitationStatusSchema = z.enum(['pending', 'accepted', 'declined', 'applied', 'withdrawn']);
/** An invitation as staff with `admin.staff.read` at its scope see it; `expired` is computed, never stored. */
export const StaffInvitationViewSchema = z.strictObject({
  id: IdSchema,
  email: z.string(),
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  definitionVersion: z.int().min(1),
  validForSeconds: z.int().nullable(),
  sensitive: z.boolean(),
  status: StaffInvitationStatusSchema,
  expired: z.boolean(),
  personId: IdSchema.nullable(),
  invitedBy: IdSchema,
  reason: z.string(),
  expiresAt: TimestampSchema,
  respondedAt: TimestampSchema.nullable(),
  approvalId: IdSchema.nullable(),
  assignmentId: IdSchema.nullable(),
  revision: z.int().min(1),
});
export type StaffInvitationView = z.infer<typeof StaffInvitationViewSchema>;

/** The invitee's own open invitation: what is offered and by whom, nothing about anyone else. */
export const MyStaffInvitationSchema = z.strictObject({
  id: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  validForSeconds: z.int().nullable(),
  reason: z.string(),
  inviterName: z.string(),
  expiresAt: TimestampSchema,
});
export type MyStaffInvitation = z.infer<typeof MyStaffInvitationSchema>;

/* ---------- Part 3: eligible roles and just-in-time activation ---------- */

/** An activation lasts at most this long, like break-glass (`BREAKGLASS_MAX_HOURS`); each role and eligibility may say less. */
export const MAX_ACTIVATION_SECONDS = BREAKGLASS_MAX_HOURS * 3600;
/** The console's default activation window. */
export const DEFAULT_ACTIVATION_SECONDS = 4 * 3600;
/** Activating a role needs a second factor used within this many seconds (the elevation's age). */
export const FRESH_SECOND_FACTOR_SECONDS = 300;

/**
 * `POST /v1/admin/staff/eligible-roles`: make a person eligible for a role at a scope (`admin.staff.assign` there),
 * with the longest activation it allows (at most the role's cap and 12 hours) and an optional end of the eligibility.
 */
export const GrantEligibleRoleCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  personId: Uuid,
  role: HubStaffRoleSchema,
  scope: InvitationScopeSchema,
  definitionVersion: z.int().min(1),
  maxActivationSeconds: z.int().min(60).max(MAX_ACTIVATION_SECONDS),
  validForSeconds: z.int().min(3600).max(31_622_400).nullable(),
});
/** `POST /v1/admin/staff/activations`: the eligible person activates a role for a window, with a fresh second factor. */
export const RequestActivationCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  eligibleRoleId: Uuid,
  windowSeconds: z.int().min(60).max(MAX_ACTIVATION_SECONDS),
});
/** `POST /v1/admin/staff/activations/:id/decide`: the second person approves or declines a sensitive activation. */
export const DecideActivationCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  decision: z.enum(['approve', 'decline']),
});

/** An eligibility as staff with `admin.staff.read` at its scope, and the eligible person, see it. */
export const StaffEligibleRoleViewSchema = z.strictObject({
  id: IdSchema,
  personId: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  definitionVersion: z.int().min(1),
  maxActivationSeconds: z.int().min(60).max(MAX_ACTIVATION_SECONDS),
  sensitive: z.boolean(),
  grantedBy: IdSchema,
  reason: z.string(),
  validFrom: TimestampSchema,
  validUntil: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
  revokedBy: IdSchema.nullable(),
  /** Whether the eligibility can be activated now (not revoked, started, not past its end). */
  open: z.boolean(),
  revision: z.int().min(1),
});
export type StaffEligibleRoleView = z.infer<typeof StaffEligibleRoleViewSchema>;

/**
 * What an activation is now, computed at every read from the activation, its approval and its assignment: `pending`
 * (a second person is asked), `active` (the role is held until `activeUntil`), `ended` (the window passed or the role
 * was revoked early), `declined`, `withdrawn`, `expired` (nobody decided within seven days).
 */
export const StaffActivationStateSchema = z.enum(['pending', 'active', 'ended', 'declined', 'withdrawn', 'expired']);
export const StaffActivationViewSchema = z.strictObject({
  id: IdSchema,
  eligibleRoleId: IdSchema,
  personId: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  windowSeconds: z.int().min(60).max(MAX_ACTIVATION_SECONDS),
  sensitive: z.boolean(),
  reason: z.string(),
  state: StaffActivationStateSchema,
  approvalId: IdSchema.nullable(),
  approvedBy: IdSchema.nullable(),
  decidedBy: IdSchema.nullable(),
  assignmentId: IdSchema.nullable(),
  activeFrom: TimestampSchema.nullable(),
  activeUntil: TimestampSchema.nullable(),
  requestedAt: TimestampSchema,
  revision: z.int().min(1),
});
export type StaffActivationView = z.infer<typeof StaffActivationViewSchema>;

/* ---------- Part 3: role change with preview ---------- */

/** One role to add in a role change; `validForSeconds` gives it an end. */
export const RoleChangeAdditionSchema = z.strictObject({
  role: HubStaffRoleSchema,
  definitionVersion: z.int().min(1),
  validForSeconds: z.int().min(60).max(400 * 24 * 3600).nullable(),
});
const RoleChangeShape = {
  personId: Uuid,
  scope: InvitationScopeSchema,
  add: z.array(RoleChangeAdditionSchema).max(3),
  remove: z.array(Uuid).max(10),
} as const;
/** `POST /v1/admin/staff/role-changes/preview`: the difference a role change would make, computed and never stored. */
export const RoleChangePreviewRequestSchema = z.strictObject(RoleChangeShape).refine((c) => c.add.length + c.remove.length > 0, { message: 'a role change adds or removes a role' });
/**
 * `POST /v1/admin/staff/role-changes/apply`: the same change with the preview's digest. The API recomputes the preview
 * from the person's roles as they are now and refuses when the digest differs (the roles changed since the preview);
 * a sensitive role names the approval of exactly that assignment (the preview gives the digest to ask for).
 */
export const RoleChangeApplyCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  ...RoleChangeShape,
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvals: z.array(z.strictObject({ role: HubStaffRoleSchema, approvalId: Uuid })).max(3),
}).refine((c) => c.add.length + c.remove.length > 0, { message: 'a role change adds or removes a role' });

/** A separation-of-duties conflict the change would create; `blocking` in full mode, a recorded warning in reduced mode. */
export const RoleChangeConflictSchema = z.strictObject({
  role: HubStaffRoleSchema,
  conflictsWith: HubStaffRoleSchema,
  blocking: z.boolean(),
});
export const RoleChangePreviewSchema = z.strictObject({
  personId: IdSchema,
  scope: StaffScopeSchema,
  before: z.strictObject({ roles: z.array(HubStaffRoleSchema), permissions: z.array(ConsolePermissionSchema) }),
  after: z.strictObject({ roles: z.array(HubStaffRoleSchema), permissions: z.array(ConsolePermissionSchema) }),
  gained: z.array(ConsolePermissionSchema),
  lost: z.array(ConsolePermissionSchema),
  sod: z.strictObject({ mode: SodModeSchema, people: z.int().min(0), conflicts: z.array(RoleChangeConflictSchema) }),
  /** The second-person approvals the change needs, with the digest each must bind. */
  approvals: z.array(z.strictObject({ role: HubStaffRoleSchema, action: z.literal('staff.assign_sensitive_role'), actionDigest: z.string().regex(/^[a-f0-9]{64}$/) })),
  /** Binds the person, the scope, their roles as they are now and the requested change; `apply` recomputes and compares it. */
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RoleChangePreview = z.infer<typeof RoleChangePreviewSchema>;

/* ---------- Part 4: access reviews ---------- */

/** A review is due between one and ninety days after it opens. */
export const ACCESS_REVIEW_MIN_SECONDS = 86_400;
export const ACCESS_REVIEW_MAX_SECONDS = 90 * 86_400;

/**
 * `POST /v1/admin/staff/access-reviews`: open a campaign over the standing assignments held exactly at a scope (all
 * roles, or the listed ones) with a deadline; needs `admin.staff.revoke` there.
 */
export const OpenAccessReviewCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  scope: InvitationScopeSchema,
  title: z.string().trim().min(1).max(200),
  roles: z.array(HubStaffRoleSchema).min(1).max(16).nullable(),
  dueInSeconds: z.int().min(ACCESS_REVIEW_MIN_SECONDS).max(ACCESS_REVIEW_MAX_SECONDS),
});
/** `POST /v1/admin/staff/access-reviews/items/:id/decide`: keep or remove, by a reviewer who is not the holder, with the command's reason. */
export const DecideAccessReviewItemCommandSchema = consoleCommand({
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
  verdict: z.enum(['keep', 'remove']),
});

export const AccessReviewCampaignStatusSchema = z.enum(['open', 'closed', 'withdrawn']);
/** One assignment under review. `state` is computed: `escalated` once the deadline passed without a verdict. */
export const AccessReviewItemSchema = z.strictObject({
  id: IdSchema,
  campaignId: IdSchema,
  assignmentId: IdSchema,
  holderPersonId: IdSchema,
  role: HubStaffRoleSchema,
  scope: StaffScopeSchema,
  state: z.enum(['pending', 'escalated', 'decided']),
  verdict: z.enum(['keep', 'remove']).nullable(),
  effect: z.enum(['kept', 'revoked', 'already_ended']).nullable(),
  decidedBy: IdSchema.nullable(),
  decidedAt: TimestampSchema.nullable(),
  reason: z.string().nullable(),
  revision: z.int().min(1),
});
export type AccessReviewItem = z.infer<typeof AccessReviewItemSchema>;
/** A campaign with its tallies (how many assignments were kept, removed or are still open; never anything about a person). */
export const AccessReviewCampaignSchema = z.strictObject({
  id: IdSchema,
  scope: StaffScopeSchema,
  title: z.string(),
  roles: z.array(HubStaffRoleSchema).nullable(),
  dueAt: TimestampSchema,
  openedBy: IdSchema,
  reason: z.string(),
  status: AccessReviewCampaignStatusSchema,
  closedAt: TimestampSchema.nullable(),
  closedBy: IdSchema.nullable(),
  items: z.strictObject({ total: z.int().min(0), kept: z.int().min(0), removed: z.int().min(0), pending: z.int().min(0), escalated: z.int().min(0) }),
  revision: z.int().min(1),
});
export type AccessReviewCampaign = z.infer<typeof AccessReviewCampaignSchema>;
