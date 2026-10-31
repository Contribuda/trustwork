import {
  permissionAllowedInScope,
  staffAssignmentActive,
  staffScopeCovers,
  type ConsolePermission,
  type HubStaffRole,
  type ScopedStaffRoleAssignment,
} from '@trustwork/contracts/client';
import type { StaffFixture } from './schemas.js';
import type { GroupDef, SectionDef } from './section-types.js';

/**
 * Console authorization helpers (ADM-002), pure and shared by the fixture adapter, the pages and the tests. The
 * server is the authority: the live adapter (ADM-001) answers the same questions from the staff tables; these
 * functions only ever narrow what a viewer sees, never widen it.
 */

export type ConsoleTarget = { nodeId: string; hubId: string | null };

/** Assignments of a person that are active now (not revoked, inside their validity window). */
export function activeAssignments(staff: StaffFixture, personId: string, now: Date): ScopedStaffRoleAssignment[] {
  return staff.assignments.filter((a) => a.personId === personId && staffAssignmentActive(a, now));
}

/** Active assignments whose scope covers the target (a hub on a node, or the node itself). */
export function coveringAssignments(staff: StaffFixture, personId: string, target: ConsoleTarget, now: Date): ScopedStaffRoleAssignment[] {
  return activeAssignments(staff, personId, now).filter((a) => staffScopeCovers(a.scope, target));
}

/** The permissions a person holds on the target: the union of the released definitions of their covering roles. */
export function permissionsFor(staff: StaffFixture, personId: string, target: ConsoleTarget, now: Date): Set<ConsolePermission> {
  const out = new Set<ConsolePermission>();
  for (const assignment of coveringAssignments(staff, personId, target, now)) {
    const definition = staff.definitions.find((d) => d.role === assignment.role && d.version === assignment.definitionVersion);
    if (!definition || !definition.scopes.includes(assignment.scope.kind)) continue;
    for (const permission of definition.permissions) if (permissionAllowedInScope(permission, assignment.scope.kind)) out.add(permission);
  }
  return out;
}

/** The roles a person holds on the target, each once, in the contract's order. */
export function rolesFor(staff: StaffFixture, personId: string, target: ConsoleTarget, now: Date): HubStaffRole[] {
  return [...new Set(coveringAssignments(staff, personId, target, now).map((a) => a.role))];
}

/** Whether a viewer with these roles and permissions may read a section. `'staff'` sections need any covering role. */
export function canRead(section: SectionDef, permissions: ReadonlySet<ConsolePermission>, hasRole: boolean): boolean {
  if (!hasRole) return false;
  return section.read === 'staff' || section.read.some((p) => permissions.has(p));
}

/** Navigation filtered by read permission: sections the viewer cannot read are absent, and empty groups disappear. */
export function visibleGroups(groups: readonly GroupDef[], permissions: ReadonlySet<ConsolePermission>, hasRole: boolean): GroupDef[] {
  return groups.map((g) => ({ ...g, sections: g.sections.filter((s) => canRead(s, permissions, hasRole)) })).filter((g) => g.sections.length > 0);
}

/** Roles whose released definition grants reading the section (shown in the denied state). */
export function rolesGranting(section: SectionDef, staff: StaffFixture): HubStaffRole[] {
  if (section.read === 'staff') return staff.definitions.map((d) => d.role);
  const read = section.read;
  return staff.definitions.filter((d) => read.some((p) => d.permissions.includes(p))).map((d) => d.role);
}

/** Whether the viewer may act with a permission on the target (the same union as reading). */
export function can(permissions: ReadonlySet<ConsolePermission>, permission: ConsolePermission): boolean {
  return permissions.has(permission);
}
