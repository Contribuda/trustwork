import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { consoleCommand, ConsolePermissionSchema, HubStaffRoleSchema, StaffScopeSchema } from './hub.js';

/**
 * ADM-004 staff lifecycle and access governance (docs/engine/hub-console/console-design.md, section 4.2). This file
 * grows with the package: part 1 holds the staff directory and the effective-access query.
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
