import type { ConsolePermission, HubStaffRole } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import type { RequestState } from '../../../common/request.js';
import type { AppContext } from '../../identity/context.js';
import type { PrincipalService } from '../../identity/principal.service.js';
import { effectiveGrants } from '../authority.js';
import { staffRoleDefinitions } from '../deps.js';
import { adminRefusal } from '../errors.js';
import { toDefs, toFacts } from '../platform-admin.service.js';
import { staffLifecycle, type EffectiveAccess, type StaffDirectory, type StaffDirectoryRow } from './deps.js';

/** An ISO timestamp in the contract's form (UTC, `Z`), whatever form PostgreSQL's JSON gave it. */
const iso = (value: string | null): string | null => (value === null ? null : new Date(value).toISOString());

const toEntry = (r: StaffDirectoryRow): StaffDirectory['entries'][number] => ({
  personId: r.person_id,
  displayName: r.display_name,
  roles: r.roles === null ? null : r.roles.map((x) => ({ assignmentId: x.assignmentId, role: x.role as HubStaffRole, scope: x.scope, validUntil: iso(x.validUntil), breakglass: x.breakglass })),
  secondFactor: r.second_factor,
});

/**
 * ADM-004 reads of the staff of a hub. Each runs as the requesting person; the database decides who may read what
 * (`staff_directory`, `staff_effective_assignments`) and answers "not found" to anyone who is not staff of the hub.
 */
export class StaffLifecycleService {
  constructor(private readonly ctx: AppContext, private readonly principals: PrincipalService) {}

  private read<T>(state: RequestState, fn: (trx: Transaction) => Promise<T>): Promise<T> {
    return this.principals.runAs(state, (trx) => fn(trx)).catch((error: unknown) => {
      throw adminRefusal(error) ?? error;
    });
  }

  directory(state: RequestState, hubId: string): Promise<StaffDirectory> {
    return this.read(state, async (trx) => {
      const rows = await staffLifecycle.directory(trx, hubId);
      return { hubId, detail: rows[0]?.detail ?? false, entries: rows.map(toEntry) };
    });
  }

  effectiveAccess(state: RequestState, hubId: string, personId: string): Promise<EffectiveAccess> {
    return this.read(state, async (trx) => {
      const [rows, defs] = await Promise.all([staffLifecycle.effectiveAssignments(trx, hubId, personId), staffRoleDefinitions.list(trx)]);
      const grants = effectiveGrants(toFacts(rows), toDefs(defs), personId, { kind: 'hub', hubId }, this.ctx.clock.now());
      return { personId, hubId, roles: grants.roles, permissions: grants.permissions as ConsolePermission[], breakglassOnly: grants.breakglassOnly as ConsolePermission[] };
    });
  }
}
