import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common/ids.js';
import { ConsolePermissionSchema, HubStaffRoleSchema, StaffScopeSchema } from './hub.js';

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
