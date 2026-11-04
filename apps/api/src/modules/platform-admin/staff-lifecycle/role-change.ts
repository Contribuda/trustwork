import { computeDigest, type ConsolePermission, type HubStaffRole, type StaffScope } from '../../../deps/contracts.js';
import { effectiveGrants, type AssignmentFact, type DefinitionFact, type StaffTarget } from '../authority.js';
import { adminDigests, type StaffRoleAssignmentRow, type StaffRoleDefinitionRow } from '../deps.js';
import { toDefs, toFacts } from '../platform-admin.service.js';
import { scopeOf } from '../views.js';
import type { RoleChangePreview } from './deps.js';

/**
 * The role-change preview (console design, section 5.5) as a pure function: permissions gained and lost at the scope,
 * the separation-of-duties conflicts the change would create, the second-person approvals it needs, and a digest that
 * binds the person, the scope, their roles as they are now and the requested change. `apply` recomputes this preview
 * from the current rows and refuses when the digest differs: the roles changed since the preview was made.
 *
 * Conflicts mirror the DATA-002 assignment guard: a conflict is `blocking` when the definition that lists the other
 * role runs in full separation-of-duties mode (that is what the database refuses); otherwise it is a recorded warning.
 * `sod.mode` reports the scope's mode by head count, as the console shows it beside every assignment.
 */
export interface RoleChangeRequest {
  personId: string;
  scope: StaffScope;
  add: ReadonlyArray<{ role: HubStaffRole; definitionVersion: number; validForSeconds: number | null }>;
  remove: readonly string[];
}

const SECOND = 1000;
const sortStrings = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort();

export class RoleChangeError extends Error {
  constructor(readonly reason: 'unknown_assignment' | 'duplicate_role', message: string) {
    super(message);
  }
}

function conflictsOf(defs: readonly DefinitionFact[], held: readonly AssignmentFact[], add: RoleChangeRequest['add']): RoleChangePreview['sod']['conflicts'] {
  const out: RoleChangePreview['sod']['conflicts'] = [];
  const definition = (role: HubStaffRole, version: number) => defs.find((d) => d.role === role && d.version === version);
  const others = [...held.map((a) => ({ role: a.role, version: a.definitionVersion })), ...add.map((a) => ({ role: a.role, version: a.definitionVersion }))];
  for (const added of add) {
    const next = definition(added.role, added.definitionVersion);
    for (const other of others) {
      if (other.role === added.role) continue;
      const def = definition(other.role, other.version);
      const listedByNext = next?.sodConflicts.includes(other.role) ?? false;
      const listedByOther = def?.sodConflicts.includes(added.role) ?? false;
      if (!listedByNext && !listedByOther) continue;
      const blocking = (listedByNext && next?.sodMode === 'full') || (listedByOther && def?.sodMode === 'full');
      if (!out.some((c) => c.role === added.role && c.conflictsWith === other.role)) out.push({ role: added.role, conflictsWith: other.role, blocking });
    }
  }
  return out.sort((a, b) => a.role.localeCompare(b.role) || a.conflictsWith.localeCompare(b.conflictsWith));
}

/**
 * @param personRows the person's assignments as the caller may read them (active ones are the basis)
 * @param sod the scope's separation-of-duties mode and head count, as the database enforces them
 */
export function previewRoleChange(request: RoleChangeRequest, personRows: StaffRoleAssignmentRow[], sod: { mode: RoleChangePreview['sod']['mode']; staffCount: number }, definitionRows: StaffRoleDefinitionRow[], sensitiveRoles: readonly HubStaffRole[], now: Date): RoleChangePreview {
  const defs = toDefs(definitionRows);
  const target: StaffTarget = request.scope;
  const active = personRows.filter((r) => r.revoked_at === null && new Date(r.valid_from).getTime() <= now.getTime() && (r.valid_until === null || new Date(r.valid_until).getTime() > now.getTime()));
  const activeIds = new Set(active.map((r) => r.id));
  for (const id of request.remove) if (!activeIds.has(id)) throw new RoleChangeError('unknown_assignment', `assignment ${id} is not an active assignment of the person`);
  const seen = new Set<string>();
  for (const a of request.add) {
    const key = `${a.role}@${a.definitionVersion}`;
    if (seen.has(key)) throw new RoleChangeError('duplicate_role', `${a.role} is added twice`);
    seen.add(key);
  }
  const held = toFacts(active);
  const kept = toFacts(active.filter((r) => !request.remove.includes(r.id)));
  const added: AssignmentFact[] = request.add.map((a) => ({
    personId: request.personId, role: a.role, scope: request.scope, definitionVersion: a.definitionVersion, breakglass: false, validFrom: now,
    validUntil: a.validForSeconds === null ? null : new Date(now.getTime() + a.validForSeconds * SECOND), revokedAt: null,
  }));
  const before = effectiveGrants(held, defs, request.personId, target, now);
  const after = effectiveGrants([...kept, ...added], defs, request.personId, target, now);
  const beforeSet = new Set<ConsolePermission>(before.permissions);
  const afterSet = new Set<ConsolePermission>(after.permissions);
  const basis = active.map((r) => ({ id: r.id, role: r.role, scope: scopeOf(r), definitionVersion: r.definition_version, validUntil: r.valid_until === null ? null : new Date(r.valid_until).toISOString() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const change = {
    add: [...request.add].map((a) => ({ role: a.role, definitionVersion: a.definitionVersion, validForSeconds: a.validForSeconds })).sort((a, b) => a.role.localeCompare(b.role) || a.definitionVersion - b.definitionVersion),
    remove: sortStrings(request.remove),
  };
  return {
    personId: request.personId,
    scope: request.scope,
    before: { roles: before.roles, permissions: before.permissions },
    after: { roles: after.roles, permissions: after.permissions },
    gained: sortStrings(after.permissions.filter((p) => !beforeSet.has(p))),
    lost: sortStrings(before.permissions.filter((p) => !afterSet.has(p))),
    sod: { mode: sod.mode, people: sod.staffCount, conflicts: conflictsOf(defs, kept, request.add) },
    approvals: change.add.filter((a) => sensitiveRoles.includes(a.role)).map((a) => ({
      role: a.role, action: 'staff.assign_sensitive_role' as const,
      actionDigest: adminDigests.assignment({ breakglass: false, personId: request.personId, role: a.role, scope: request.scope, definitionVersion: a.definitionVersion, validForSeconds: a.validForSeconds }),
    })),
    previewDigest: computeDigest({ kind: 'staff.role_change_preview', personId: request.personId, scope: request.scope, basis, ...change }).value,
  };
}
