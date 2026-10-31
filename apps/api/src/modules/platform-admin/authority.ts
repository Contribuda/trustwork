import { NODE_ONLY_PERMISSIONS, type ConsolePermission, type HubStaffRole, type SodMode, type StaffScope } from '../../deps/contracts.js';

/**
 * Staff authority as pure functions (ADM-001 step 1): which `admin.*` grants a person holds at a target, the
 * separation-of-duties mode of a scope and the role checks of that mode. They mirror, rule for rule, what the DATA-002
 * database resolves in `trustwork.admin_resolve_permission` and the assignment guard, so the console can explain a
 * refusal before it happens; the database stays the authority (tests/admin/authority.test.ts compares both on real
 * PostgreSQL).
 *
 * Coverage: a platform assignment covers everything; a node assignment covers its node and every hub of the
 * installation (one database is one node); a hub assignment covers that hub only and never a node-only permission.
 */
export interface AssignmentFact {
  personId: string;
  role: HubStaffRole;
  scope: StaffScope;
  definitionVersion: number;
  breakglass: boolean;
  validFrom: Date;
  validUntil: Date | null;
  revokedAt: Date | null;
}
export interface DefinitionFact {
  role: HubStaffRole;
  version: number;
  scopes: readonly StaffScope['kind'][];
  permissions: readonly ConsolePermission[];
  sodMode: SodMode;
  sodConflicts: readonly HubStaffRole[];
  grantMaxHours: number;
}
/** What an action applies to: the platform, the node, or one hub (the same shape as a staff scope). */
export type StaffTarget = StaffScope;

/** Below this many distinct staff people covering a scope the scope runs in reduced separation-of-duties mode. */
export const FULL_SOD_MIN_STAFF = 5;

const definitionOf = (defs: readonly DefinitionFact[], a: AssignmentFact) => defs.find((d) => d.role === a.role && d.version === a.definitionVersion);

export function assignmentActive(a: AssignmentFact, now: Date): boolean {
  const t = now.getTime();
  return a.revokedAt === null && a.validFrom.getTime() <= t && (a.validUntil === null || a.validUntil.getTime() > t);
}

/** Does an assignment held at `scope` cover `target` (for `permission`, when given)? */
export function scopeCovers(scope: StaffScope, target: StaffTarget, permission?: ConsolePermission): boolean {
  if (scope.kind === 'platform') return true;
  if (scope.kind === 'node') return target.kind === 'hub' || (target.kind === 'node' && target.nodeId === scope.nodeId);
  if (target.kind !== 'hub' || target.hubId !== scope.hubId) return false;
  return permission === undefined || !NODE_ONLY_PERMISSIONS.includes(permission);
}

/** Active assignments of a person whose released definition allows their scope and whose scope covers the target. */
function covering(assignments: readonly AssignmentFact[], defs: readonly DefinitionFact[], personId: string, target: StaffTarget, now: Date) {
  return assignments.flatMap((a) => {
    if (a.personId !== personId || !assignmentActive(a, now) || !scopeCovers(a.scope, target)) return [];
    const def = definitionOf(defs, a);
    return def && def.scopes.includes(a.scope.kind) ? [{ assignment: a, def }] : [];
  });
}

export interface EffectiveGrants { roles: HubStaffRole[]; permissions: ConsolePermission[]; breakglassOnly: ConsolePermission[] }

/**
 * The materialised `admin.*` grants of a person at a target: the roles that cover it and the union of their released
 * permissions (node-only permissions are never granted through a hub assignment). `breakglassOnly` lists permissions
 * held only through a break-glass assignment (the audit marks their use).
 */
export function effectiveGrants(assignments: readonly AssignmentFact[], defs: readonly DefinitionFact[], personId: string, target: StaffTarget, now: Date): EffectiveGrants {
  const roles = new Set<HubStaffRole>();
  const regular = new Set<ConsolePermission>();
  const glass = new Set<ConsolePermission>();
  for (const { assignment, def } of covering(assignments, defs, personId, target, now)) {
    roles.add(assignment.role);
    for (const p of def.permissions) {
      if (!scopeCovers(assignment.scope, target, p)) continue;
      (assignment.breakglass ? glass : regular).add(p);
    }
  }
  const permissions = [...new Set([...regular, ...glass])].sort();
  return { roles: [...roles].sort(), permissions, breakglassOnly: [...glass].filter((p) => !regular.has(p)).sort() };
}

export function holds(assignments: readonly AssignmentFact[], defs: readonly DefinitionFact[], personId: string, permission: ConsolePermission, target: StaffTarget, now: Date): boolean {
  return effectiveGrants(assignments, defs, personId, target, now).permissions.includes(permission);
}

/** The roles through which a person holds any of `permissions` at the target. */
export function rolesGranting(assignments: readonly AssignmentFact[], defs: readonly DefinitionFact[], personId: string, permissions: readonly ConsolePermission[], target: StaffTarget, now: Date): HubStaffRole[] {
  const out = new Set<HubStaffRole>();
  for (const { assignment, def } of covering(assignments, defs, personId, target, now)) {
    if (permissions.some((p) => def.permissions.includes(p) && scopeCovers(assignment.scope, target, p))) out.add(assignment.role);
  }
  return [...out].sort();
}

export interface SodEvaluation { mode: SodMode; staffCount: number; minimumForFull: number }

/** The separation-of-duties mode of a target: `reduced` below five distinct staff people covering it, `full` from five. */
export function sodEvaluation(assignments: readonly AssignmentFact[], defs: readonly DefinitionFact[], target: StaffTarget, now: Date): SodEvaluation {
  const people = new Set(assignments.filter((a) => covering([a], defs, a.personId, target, now).length > 0).map((a) => a.personId));
  return { mode: people.size >= FULL_SOD_MIN_STAFF ? 'full' : 'reduced', staffCount: people.size, minimumForFull: FULL_SOD_MIN_STAFF };
}

/**
 * The second person of a two-person action. Every mode: a different person (the database enforces it too). Full mode
 * additionally: the approver acts through a role the requester does not hold for that action ("the second with a
 * different role", docs/engine/hub-administration.md).
 */
export function approverAllowed(input: { mode: SodMode; requesterId: string; approverId: string; requesterRoles: readonly HubStaffRole[]; approverRoles: readonly HubStaffRole[] }): { ok: true } | { ok: false; reason: 'self_approval' | 'same_role' | 'no_role' } {
  if (input.requesterId === input.approverId) return { ok: false, reason: 'self_approval' };
  if (!input.approverRoles.length) return { ok: false, reason: 'no_role' };
  if (input.mode === 'full' && input.approverRoles.every((r) => input.requesterRoles.includes(r))) return { ok: false, reason: 'same_role' };
  return { ok: true };
}

/** Hard role conflicts a new assignment would create (a full-mode definition on either side lists the other role). */
export function assignmentConflicts(defs: readonly DefinitionFact[], held: readonly AssignmentFact[], newRole: HubStaffRole, newVersion: number, now: Date): HubStaffRole[] {
  const next = defs.find((d) => d.role === newRole && d.version === newVersion);
  const out = new Set<HubStaffRole>();
  for (const a of held) {
    if (a.revokedAt !== null || (a.validUntil !== null && a.validUntil.getTime() <= now.getTime())) continue;
    const def = definitionOf(defs, a);
    if ((next?.sodMode === 'full' && next.sodConflicts.includes(a.role)) || (def?.sodMode === 'full' && def.sodConflicts.includes(newRole))) out.add(a.role);
  }
  return [...out].sort();
}
